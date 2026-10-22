import type { z } from 'zod';

// A request the client got wrong: the dashboard server answers it with `status`
// and `message` verbatim. Anything else that escapes a route is a bug or an
// environment fault, so the server logs it and answers a generic 500 instead of
// echoing parser, TypeError or SQLite text.
export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Parse a request's JSON body without checking its shape; unparseable JSON is a 400. */
export async function jsonValue(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** Parse a request's JSON body that must be a plain object; null, arrays and scalars are a 400 too. */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  const value = await jsonValue(req);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid JSON body');
  }
  return value as T;
}

/** The first few zod issues as one plain line ("name: Invalid input: expected string, received object"). */
export function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/**
 * Check a parsed body's field types against `schema`; a mismatch (an object, array or number where a string is
 * expected, and so on) is a 400 with zod's plain message, never a TypeError or SQLite bind 500.
 */
export function checkBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error));
  return parsed.data;
}
