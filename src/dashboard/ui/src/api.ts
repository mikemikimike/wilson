import {
  RequiresConnectionError,
  isNetworkError,
  mirroredHttpErrorMessage,
  resolveFetchOutcome,
} from './store/offline-writes';
// mirror-client deliberately does NOT import this module: its sync pulls must
// bypass the mirror fallback, so it uses its own authed fetch. This import only
// brings tryMirror, which is called at fetch time, never at module-eval time.
import { tryMirror } from './store/mirror-client';
import { bearerHeader, readAuthToken, reportUnauthorized } from './lib/authSession';

/**
 * Relative in dev too: the page on :5173 talks to the dashboard through vite's proxy (see
 * vite.config.ts), so every request is same-origin and the server's Origin / Host gate sees
 * what a production page would send. Run the server with WILSON_DASHBOARD_DEV=1.
 */
export function getBaseUrl(): string {
  if (import.meta.env.DEV) return '';
  return window.location.origin;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const token = readAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
    ...bearerHeader(token),
  };

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, {
      ...options,
      headers,
    });
  } catch (err) {
    // Connection-level failure only (server unreachable). HTTP errors below
    // mean the server answered, so they never fall back to the mirror. An
    // offline GET the mirror cannot serve becomes RequiresConnectionError —
    // the UI's explicit "unavailable offline" signal — instead of a raw
    // TypeError; mirrored GETs return the mirror's rows.
    if (isNetworkError(err)) {
      const method = (options?.method ?? 'GET').toUpperCase();
      const isWrite = method !== 'GET';
      const mirrored = isWrite ? null : await tryMirror(path).catch(() => null);
      const outcome = resolveFetchOutcome({ isWrite, networkError: true, mirrored });
      if (outcome === 'return-mirror') {
        // A mirrored 400 (the drill endpoints' shared BadRequest) fails the
        // same way the online request would.
        const httpError = mirroredHttpErrorMessage(mirrored);
        if (httpError) throw new Error(httpError);
        return mirrored as T;
      }
      if (outcome === 'throw-requires-connection') {
        throw new RequiresConnectionError();
      }
    }
    throw err;
  }

  if (!res.ok) {
    // A 401 means this tab has no valid login any more: the gate swaps the app for the login view.
    if (res.status === 401) reportUnauthorized(path, token);
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

/**
 * fetch with the auth token attached, returning the raw Response. Used by the
 * hybrid chat client and the file downloads, which need Response objects
 * rather than parsed JSON. A 401 is reported like api()'s; the caller still
 * gets the Response.
 */
export async function authedFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = readAuthToken();
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> | undefined),
    ...bearerHeader(token),
  };
  const res = await fetch(`${getBaseUrl()}${path}`, { ...options, headers });
  if (res.status === 401) reportUnauthorized(path, token);
  return res;
}