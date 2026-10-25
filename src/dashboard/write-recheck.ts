/**
 * Central write-time auth re-check (#157).
 *
 * The auth middleware runs once, when a request's headers arrive. Bun hands the
 * request to `fetch` at that point, so a write whose body is still on the wire
 * can find dashboard auth switched on (the admin finishing `/api/auth/setup`)
 * by the time a route's `await req.json()` returns. If auth was off at arrival
 * the request carries no login; running it afterwards would be an anonymous
 * write on an authenticated dashboard.
 *
 * Rather than patch each of the ~30 routes that read a body, the server calls
 * `readBodyThenRecheck` once, before routing, for every state-changing request.
 * It reads the whole body, asks whether the request's authority changed meanwhile
 * (auth switched on under a login-less request, the login it arrived with was
 * deactivated / logged out / expired, or the active profile changed), and then
 * leaves the bytes on the request so the route's own `req.json()` still works
 * unchanged. A route added later is covered without remembering to ask.
 */

import { HttpError } from './http-errors.js';

/** Methods that change state. Anything else (GET, HEAD, OPTIONS) is read-only and never waits on a body. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/**
 * Cap on a write's body (#197): 1 MB, far above any JSON body a dashboard route takes (the largest, a chat query, is
 * at most 100,000 characters). /api/import keeps Bun's own limit and the demo trace step has its own (`bodyCapFor`).
 */
export const JSON_BODY_MAX_BYTES = 1_048_576;

/**
 * Routes that carry a whole parsed statement (thousands of rows). /api/import keeps Bun's own request-body limit
 * (`maxRequestBodySize`, 128 MB by default), exactly as before the JSON cap existed. The demo trace step is capped
 * at TRACE_BODY_MAX_BYTES: it refuses more than 2,000 rows anyway, so it never needs Bun's full limit.
 */
const IMPORT_BODY_PATHS = new Set(['/api/import']);
export const TRACE_BODY_MAX_BYTES = 16 * 1_048_576;
const BODY_CAPS: Record<string, number> = { '/api/demo/trace/step': TRACE_BODY_MAX_BYTES };

/** The body cap for a write to `path`: a route's own cap, undefined (Bun's limit) for /api/import, else JSON_BODY_MAX_BYTES. */
export function bodyCapFor(path: string): number | undefined {
  if (IMPORT_BODY_PATHS.has(path)) return undefined;
  return BODY_CAPS[path] ?? JSON_BODY_MAX_BYTES;
}

/** The 413 for a body over `max` bytes. */
function tooLarge(max: number): HttpError {
  return new HttpError(413, `request body is larger than ${max / 1_048_576} MB`);
}

/**
 * The whole body, or a 413 HttpError once more than `max` bytes are declared (Content-Length: refused before any
 * byte is read) or have arrived (counted while streaming, so a chunked body without a length cannot slip past).
 */
async function readCapped(req: Request, max: number | undefined): Promise<ArrayBuffer> {
  if (max === undefined) return req.arrayBuffer();
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > max) throw tooLarge(max);
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}

/** The body readers a route may call. After buffering they all serve the same bytes. */
const BODY_READERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const;

/**
 * Read the request body to the end, then ask whether the request's authority
 * changed while it was arriving. The bytes stay available to the route:
 * `req.json()` and friends are re-pointed at the buffered copy. The original
 * `Request` object is kept (not rebuilt) because `Bun.Server.requestIP(req)` is
 * keyed on it.
 *
 * `check()` returns null while the request may proceed, or a reason to refuse:
 * auth switched on under a request that arrived without a login, the login it
 * arrived with was deactivated / logged out / expired, or the active profile
 * changed (a request validated against profile A must never run on profile B).
 * The reason is handed back so the caller picks the status. A body that cannot
 * be read (client hung up) rejects, exactly as the route's own read would have. With `maxBytes`, a body over it
 * rejects with a 413 HttpError before the rest is read and before `check()` or any route runs.
 */
export async function readBodyThenRecheck<R>(req: Request, check: () => R | null, maxBytes?: number): Promise<R | null> {
  const bytes = await readCapped(req, maxBytes);
  const refusal = check();
  if (refusal !== null) return refusal;
  const contentType = req.headers.get('Content-Type');
  const replay = () => new Response(bytes, contentType ? { headers: { 'Content-Type': contentType } } : undefined);
  for (const name of BODY_READERS) {
    Object.defineProperty(req, name, { configurable: true, value: () => replay()[name]() });
  }
  return null;
}
