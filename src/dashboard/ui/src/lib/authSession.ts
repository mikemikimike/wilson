/**
 * The dashboard login session, kept in one place.
 *
 * Every request that carries the bearer token reads it here, and every 401 is reported here, so an expired,
 * revoked or logged-out session sends the person back to the login view (components/AuthGate.tsx) instead of
 * leaving tabs that fail one by one. The legacy HTML dashboard (src/dashboard/html.ts) and the WebMCP bridge read
 * the same key. It imports nothing, so store/mirror-client.ts (which must not import api.ts) can use it too, and
 * bun tests can import it directly.
 */

/** The one localStorage key for the dashboard session token, shared by both dashboards and the WebMCP bridge. */
export const AUTH_TOKEN_KEY = 'wilson_auth_token';
/** The legacy dashboard's old key. Read once as a fallback, then removed. */
export const LEGACY_AUTH_TOKEN_KEY = 'oa_token';

/** The routes the server serves without a login (PUBLIC_AUTH_PATHS in src/dashboard/server.ts). */
const PUBLIC_AUTH_PATHS = ['/api/auth/status', '/api/auth/setup', '/api/auth/login'];

/** The part of Storage this module uses, so tests can pass a plain object. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): TokenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored token, or null (none, or storage blocked). */
export function readAuthToken(storage: TokenStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(AUTH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function writeAuthToken(token: string, storage: TokenStorage | null = browserStorage()): void {
  try {
    storage?.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // Blocked storage: the session lasts until the next reload.
  }
}

export function clearAuthToken(storage: TokenStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // Blocked storage: nothing was stored.
  }
}

/**
 * Move a token the legacy dashboard stored under `oa_token` to the shared key. A token already under the shared
 * key wins (it is the newer login); the old key is removed either way, so this runs at most once per browser.
 */
export function migrateLegacyAuthToken(storage: TokenStorage | null = browserStorage()): void {
  try {
    if (!storage) return;
    const legacy = storage.getItem(LEGACY_AUTH_TOKEN_KEY);
    if (legacy === null) return;
    if (legacy && !storage.getItem(AUTH_TOKEN_KEY)) storage.setItem(AUTH_TOKEN_KEY, legacy);
    storage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  } catch {
    // Blocked storage: there is nothing to migrate.
  }
}

/** `{ Authorization }` for `token`, or nothing when there is no token. */
export function bearerHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isPublicAuthPath(path: string): boolean {
  const bare = path.split(/[?#]/, 1)[0];
  return PUBLIC_AUTH_PATHS.includes(bare);
}

// ── Session changes ─────────────────────────────────────────────────────────

type SessionChangeListener = () => void;
const sessionChangeListeners = new Set<SessionChangeListener>();

/**
 * Run `listener` whenever this tab's login may have changed: a request was refused with 401, or this tab turned
 * auth on or off. The gate re-checks GET /api/auth/status rather than trusting the signal, so a stray 401 from a
 * request that raced an auth change cannot lock out a dashboard whose auth is off. Returns an unsubscribe function.
 */
export function onSessionChange(listener: SessionChangeListener): () => void {
  sessionChangeListeners.add(listener);
  return () => { sessionChangeListeners.delete(listener); };
}

export function notifySessionChange(): void {
  for (const listener of sessionChangeListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[auth] a session-change listener failed:', err);
    }
  }
}

/**
 * A request to `path`, sent with `sentToken`, came back 401. Outside the public auth routes that means this tab
 * has no valid login (expired, logged out, revoked by deactivation, or auth switched on meanwhile): forget the
 * token it sent and tell the gate. A 401 from /api/auth/login is a wrong password, not a lost session.
 *
 * The token is cleared only if it is still the stored one: another tab may already have logged in again, and
 * its fresh token must survive this tab's stale request. Returns whether the session counted as lost.
 */
export function reportUnauthorized(path: string, sentToken: string | null, storage: TokenStorage | null = browserStorage()): boolean {
  if (isPublicAuthPath(path)) return false;
  if (sentToken !== null && readAuthToken(storage) === sentToken) clearAuthToken(storage);
  notifySessionChange();
  return true;
}

// ── Gate ────────────────────────────────────────────────────────────────────

/** GET /api/auth/status. */
export interface AuthStatusResponse {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
  userCount: number;
}

/** What the status check produced. `sentToken` is the token the check carried. */
export type AuthCheck =
  | { kind: 'status'; status: AuthStatusResponse; sentToken: string | null }
  | { kind: 'http-error'; message: string }
  | { kind: 'network-error' };

/** Which screen the dashboard shows. */
export type AuthGateView =
  | { kind: 'checking' }
  /** `userId` is null when auth is off (or the server could not be reached). */
  | { kind: 'app'; userId: number | null }
  /**
   * `sessionEnded`: this tab had a login (a stored token, or the app was showing) and it is gone now.
   * `offline`: the server could not be reached, and the offline copy belongs to a profile with auth on.
   */
  | { kind: 'login'; sessionEnded: boolean; offline?: boolean }
  /** Auth is on and no user exists: /api/auth/setup is the only way in. */
  | { kind: 'setup' }
  | { kind: 'unavailable'; message: string };

/**
 * The screen for a status check, given the screen before it.
 *
 * - Auth off, or a valid login: the app.
 * - Auth on, no login, no users at all: the first-admin setup. The server still allows /api/auth/setup then, and
 *   it is the only way to get a login (PATCH /api/auth/config refuses to enable auth with no admin, #157, so this
 *   is a profile whose flag was set some other way).
 * - Auth on, no login, users exist: the login form. Whether any of them can still log in (an active admin, or any
 *   active user) is deliberately not exposed by the public status route; a deactivated account gets the same
 *   "Invalid credentials" as a wrong password.
 * - The server answered with an error (e.g. the LAN rule's 503 for a profile with no auth): say so, with its words.
 * - The server is unreachable and `offlineLocked` (the offline copy is a profile with auth on, and there is no
 *   stored login; store/mirror-session.ts offlineLoginRequired): the login form, marked offline. The mirror is
 *   never served without a login.
 * - Otherwise unreachable on the first check: the app, which serves what the offline mirror holds, as before
 *   this gate existed. On a re-check the screen stays as it was: a network blip must neither rebuild the app nor
 *   open it from the login form.
 */
export function authGateView(check: AuthCheck, previous: AuthGateView = { kind: 'checking' }, offlineLocked = false): AuthGateView {
  if (check.kind === 'network-error') {
    if (offlineLocked) return { kind: 'login', sessionEnded: endedSession(null, previous), offline: true };
    return previous.kind === 'checking' ? { kind: 'app', userId: null } : previous;
  }
  if (check.kind === 'http-error') return { kind: 'unavailable', message: check.message };
  const { status } = check;
  if (!status.authEnabled) return { kind: 'app', userId: null };
  if (status.user) return { kind: 'app', userId: status.user.id };
  if (status.userCount === 0) return { kind: 'setup' };
  return { kind: 'login', sessionEnded: endedSession(check.sentToken, previous) };
}

/** Whether a login screen reached from `previous` follows a lost session (and says so). */
function endedSession(sentToken: string | null, previous: AuthGateView): boolean {
  // A re-check while the login form shows (the second run of a 401 burst, another tab) keeps its notice.
  return sentToken !== null || previous.kind === 'app' || (previous.kind === 'login' && previous.sessionEnded);
}

/** What applying a status check asks of the gate. */
export interface SettledAuthCheck {
  view: AuthGateView;
  /** Rebuild the app (a new login, or auth switched on or off). */
  remount: boolean;
  /** Lock and wipe the offline mirror before showing `view` (store/mirror-client.ts lockMirror). */
  wipe: boolean;
}

/**
 * Apply a status check: the next screen, and whether the app must be rebuilt. A token the server just reported
 * as no login (auth on, `user` null) is dead, so it is forgotten, unless another tab replaced it meanwhile.
 *
 * The app is rebuilt when it was not showing, or when it now belongs to a different login (another tab logged in
 * as someone else, or auth was switched on or off here), since role-dependent views and the mirror were loaded
 * for the old one. A re-check that confirms the same login keeps everything mounted.
 *
 * Every login or setup screen means auth is on and this tab has no login, so the offline mirror is wiped first,
 * each time (a wipe that found nothing is cheap, and one another tab could not finish gets another go).
 */
export function settleAuthCheck(
  check: AuthCheck,
  previous: AuthGateView,
  storage: TokenStorage | null = browserStorage(),
  offlineLocked = false,
): SettledAuthCheck {
  if (check.kind === 'status' && check.status.authEnabled && !check.status.user && check.sentToken !== null
    && readAuthToken(storage) === check.sentToken) {
    clearAuthToken(storage);
  }
  const view = authGateView(check, previous, offlineLocked);
  const remount = view.kind === 'app' && (previous.kind !== 'app' || previous.userId !== view.userId);
  const wipe = view.kind === 'login' || view.kind === 'setup';
  return { view, remount, wipe };
}

/** A `storage` event that changes the session: the token key itself, or the whole store cleared (key null). */
export function isSessionStorageChange(key: string | null): boolean {
  return key === null || key === AUTH_TOKEN_KEY;
}

/**
 * Wrap `run` so overlapping calls share one run, plus at most one more after it (a call that arrived mid-run may
 * have seen newer state). A burst of 401s from a page's parallel requests then costs two status checks, not one each.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  return () => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
