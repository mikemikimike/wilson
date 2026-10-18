import { describe, expect, test, afterEach } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, deactivateUser, enableAuth } from '../dashboard/auth.js';
import {
  AUTH_TOKEN_KEY,
  LEGACY_AUTH_TOKEN_KEY,
  authGateView,
  bearerHeader,
  clearAuthToken,
  coalesced,
  isPublicAuthPath,
  isSessionStorageChange,
  migrateLegacyAuthToken,
  notifySessionChange,
  onSessionChange,
  readAuthToken,
  reportUnauthorized,
  settleAuthCheck,
  writeAuthToken,
  type AuthCheck,
  type AuthStatusResponse,
  type TokenStorage,
} from '../dashboard/ui/src/lib/authSession.js';

/**
 * The React dashboard's login session (ui/src/lib/authSession.ts + components/AuthGate.tsx). The UI package has no
 * component test runner, so the gate's decisions live in the pure module and are tested here, together with the
 * real server answers they react to (expired, logged-out and deactivated sessions, a profile with auth on and no
 * users). The legacy dashboard's side of the shared key is in dashboard-legacy-token-key.test.ts.
 */

function memoryStorage(initial: Record<string, string> = {}): TokenStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const throwingStorage: TokenStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

function status(s: Partial<AuthStatusResponse>): AuthStatusResponse {
  return { authEnabled: true, user: null, userCount: 1, ...s };
}

describe('token storage', () => {
  test('one shared key: read, write, clear', () => {
    const storage = memoryStorage();
    expect(AUTH_TOKEN_KEY).toBe('wilson_auth_token');
    expect(readAuthToken(storage)).toBeNull();
    writeAuthToken('t1', storage);
    expect(storage.data.get('wilson_auth_token')).toBe('t1');
    expect(readAuthToken(storage)).toBe('t1');
    clearAuthToken(storage);
    expect(readAuthToken(storage)).toBeNull();
  });

  test('blocked storage never throws', () => {
    expect(readAuthToken(throwingStorage)).toBeNull();
    expect(() => writeAuthToken('t', throwingStorage)).not.toThrow();
    expect(() => clearAuthToken(throwingStorage)).not.toThrow();
    expect(() => migrateLegacyAuthToken(throwingStorage)).not.toThrow();
    expect(readAuthToken(null)).toBeNull();
  });

  test('an empty stored token counts as none', () => {
    expect(readAuthToken(memoryStorage({ [AUTH_TOKEN_KEY]: '' }))).toBeNull();
  });

  test('bearerHeader sends nothing without a token', () => {
    expect(bearerHeader(null)).toEqual({});
    expect(bearerHeader('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('migrateLegacyAuthToken', () => {
  test("moves the legacy dashboard's oa_token to the shared key, then removes it", () => {
    const storage = memoryStorage({ [LEGACY_AUTH_TOKEN_KEY]: 'old' });
    migrateLegacyAuthToken(storage);
    expect(storage.data.get(AUTH_TOKEN_KEY)).toBe('old');
    expect(storage.data.has(LEGACY_AUTH_TOKEN_KEY)).toBe(false);
  });

  test('a token already under the shared key wins; the old key still goes', () => {
    const storage = memoryStorage({ [LEGACY_AUTH_TOKEN_KEY]: 'old', [AUTH_TOKEN_KEY]: 'new' });
    migrateLegacyAuthToken(storage);
    expect(storage.data.get(AUTH_TOKEN_KEY)).toBe('new');
    expect(storage.data.has(LEGACY_AUTH_TOKEN_KEY)).toBe(false);
  });

  test('nothing to migrate leaves storage alone; an empty legacy value is just removed', () => {
    const none = memoryStorage({ [AUTH_TOKEN_KEY]: 'new' });
    migrateLegacyAuthToken(none);
    expect([...none.data.entries()]).toEqual([[AUTH_TOKEN_KEY, 'new']]);
    const empty = memoryStorage({ [LEGACY_AUTH_TOKEN_KEY]: '' });
    migrateLegacyAuthToken(empty);
    expect(empty.data.size).toBe(0);
  });
});

describe('reportUnauthorized', () => {
  test('a 401 from a public auth route (wrong password at login) is not a lost session', () => {
    const storage = memoryStorage({ [AUTH_TOKEN_KEY]: 't1' });
    let calls = 0;
    const off = onSessionChange(() => { calls++; });
    try {
      expect(reportUnauthorized('/api/auth/login', 't1', storage)).toBe(false);
      expect(reportUnauthorized('/api/auth/setup', 't1', storage)).toBe(false);
      expect(reportUnauthorized('/api/auth/status?x=1', 't1', storage)).toBe(false);
    } finally {
      off();
    }
    expect(calls).toBe(0);
    expect(storage.data.get(AUTH_TOKEN_KEY)).toBe('t1');
  });

  test('any other 401 forgets the token it was sent with and tells the gate', () => {
    const storage = memoryStorage({ [AUTH_TOKEN_KEY]: 't1' });
    let calls = 0;
    const off = onSessionChange(() => { calls++; });
    try {
      expect(reportUnauthorized('/api/accounts', 't1', storage)).toBe(true);
    } finally {
      off();
    }
    expect(calls).toBe(1);
    expect(storage.data.has(AUTH_TOKEN_KEY)).toBe(false);
  });

  test("a stale request's 401 keeps a newer token another tab stored meanwhile", () => {
    const storage = memoryStorage({ [AUTH_TOKEN_KEY]: 'fresh' });
    expect(reportUnauthorized('/api/summary', 'stale', storage)).toBe(true);
    expect(storage.data.get(AUTH_TOKEN_KEY)).toBe('fresh');
  });

  test('a failing listener does not stop the others; unsubscribe works', () => {
    let reached = 0;
    const offA = onSessionChange(() => { throw new Error('boom'); });
    const offB = onSessionChange(() => { reached++; });
    const originalError = console.error;
    console.error = () => {};
    try {
      notifySessionChange();
      offB();
      notifySessionChange();
    } finally {
      console.error = originalError;
      offA();
    }
    expect(reached).toBe(1);
  });

  test('isPublicAuthPath matches only the three public routes', () => {
    expect(isPublicAuthPath('/api/auth/login')).toBe(true);
    expect(isPublicAuthPath('/api/auth/status#x')).toBe(true);
    expect(isPublicAuthPath('/api/auth/logout')).toBe(false);
    expect(isPublicAuthPath('/api/auth/users')).toBe(false);
    expect(isPublicAuthPath('/api/auth/login/extra')).toBe(false);
  });
});

describe('authGateView', () => {
  const ok = (s: AuthStatusResponse, sentToken: string | null = null): AuthCheck => ({ kind: 'status', status: s, sentToken });

  test('auth off: the app, with no login', () => {
    expect(authGateView(ok(status({ authEnabled: false, userCount: 0 })))).toEqual({ kind: 'app', userId: null });
  });

  test('auth on with a valid login: the app for that user', () => {
    expect(authGateView(ok(status({ user: { id: 7, username: 'a', role: 'viewer' } }), 't'))).toEqual({ kind: 'app', userId: 7 });
  });

  test('auth on, no login, users exist: the login form', () => {
    expect(authGateView(ok(status({ userCount: 2 })))).toEqual({ kind: 'login', sessionEnded: false });
  });

  test('a stored token the server no longer accepts, or a lost login while the app showed: "session ended"', () => {
    expect(authGateView(ok(status({}), 'dead'))).toEqual({ kind: 'login', sessionEnded: true });
    expect(authGateView(ok(status({})), { kind: 'app', userId: 3 })).toEqual({ kind: 'login', sessionEnded: true });
  });

  test('the second re-check of a 401 burst (token already cleared, login already showing) keeps the notice', () => {
    const first = authGateView(ok(status({})), { kind: 'app', userId: 3 });
    expect(authGateView(ok(status({})), first)).toEqual({ kind: 'login', sessionEnded: true });
    expect(authGateView(ok(status({})), { kind: 'login', sessionEnded: false })).toEqual({ kind: 'login', sessionEnded: false });
  });

  test('auth on and zero users: the setup path, not a login form nobody can pass', () => {
    expect(authGateView(ok(status({ userCount: 0 })))).toEqual({ kind: 'setup' });
  });

  test("the server's error is shown in its own words", () => {
    expect(authGateView({ kind: 'http-error', message: 'needs auth' })).toEqual({ kind: 'unavailable', message: 'needs auth' });
  });

  test('unreachable on the first check: the app (offline mirror); on a re-check: the screen stays', () => {
    expect(authGateView({ kind: 'network-error' })).toEqual({ kind: 'app', userId: null });
    expect(authGateView({ kind: 'network-error' }, { kind: 'login', sessionEnded: false })).toEqual({ kind: 'login', sessionEnded: false });
    expect(authGateView({ kind: 'network-error' }, { kind: 'app', userId: 4 })).toEqual({ kind: 'app', userId: 4 });
  });

  test('unreachable, offline copy of an auth profile, no stored login: the offline login form, never the app', () => {
    const offline = (previous?: Parameters<typeof authGateView>[1]) => authGateView({ kind: 'network-error' }, previous, true);
    expect(offline()).toEqual({ kind: 'login', sessionEnded: false, offline: true });
    // Another tab logged out while this one showed the app and the server was down.
    expect(offline({ kind: 'app', userId: 4 })).toEqual({ kind: 'login', sessionEnded: true, offline: true });
    expect(offline({ kind: 'login', sessionEnded: true })).toEqual({ kind: 'login', sessionEnded: true, offline: true });
  });

  test('reachable again: the offline mark goes, whatever the lock said', () => {
    expect(authGateView(ok(status({})), { kind: 'login', sessionEnded: false, offline: true }, true)).toEqual({ kind: 'login', sessionEnded: false });
    expect(authGateView(ok(status({ authEnabled: false })), { kind: 'login', sessionEnded: false, offline: true }, true)).toEqual({ kind: 'app', userId: null });
  });
});

describe('settleAuthCheck', () => {
  const login = { kind: 'login', sessionEnded: false } as const;

  test('logging in rebuilds the app; a re-check that confirms the same login does not', () => {
    const asUser = (id: number): AuthCheck => ({ kind: 'status', status: status({ user: { id, username: 'u', role: 'admin' } }), sentToken: 't' });
    expect(settleAuthCheck(asUser(1), login, memoryStorage()).remount).toBe(true);
    expect(settleAuthCheck(asUser(1), { kind: 'app', userId: 1 }, memoryStorage()).remount).toBe(false);
    // Another tab logged in as someone else.
    expect(settleAuthCheck(asUser(2), { kind: 'app', userId: 1 }, memoryStorage()).remount).toBe(true);
  });

  test('turning auth on or off here rebuilds the app for the new login state', () => {
    const off: AuthCheck = { kind: 'status', status: status({ authEnabled: false }), sentToken: 't' };
    expect(settleAuthCheck(off, { kind: 'app', userId: 1 }, memoryStorage()).remount).toBe(true);
  });

  test('a network blip on a re-check neither rebuilds the app nor opens it from the login form', () => {
    expect(settleAuthCheck({ kind: 'network-error' }, { kind: 'app', userId: 1 }, memoryStorage())).toEqual({
      view: { kind: 'app', userId: 1 },
      remount: false,
      wipe: false,
      session: null,
    });
    expect(settleAuthCheck({ kind: 'network-error' }, login, memoryStorage()).view).toEqual(login);
  });

  test('every login or setup screen wipes the mirror first; the app never does', () => {
    const asUser: AuthCheck = { kind: 'status', status: status({ user: { id: 1, username: 'u', role: 'admin' } }), sentToken: 't' };
    const noLogin: AuthCheck = { kind: 'status', status: status({}), sentToken: null };
    const noUsers: AuthCheck = { kind: 'status', status: status({ userCount: 0 }), sentToken: null };
    expect(settleAuthCheck(noLogin, { kind: 'app', userId: 1 }, memoryStorage()).wipe).toBe(true);
    expect(settleAuthCheck(noLogin, { kind: 'checking' }, memoryStorage()).wipe).toBe(true);
    expect(settleAuthCheck(noLogin, login, memoryStorage()).wipe).toBe(true);
    expect(settleAuthCheck(noUsers, { kind: 'checking' }, memoryStorage()).wipe).toBe(true);
    expect(settleAuthCheck({ kind: 'network-error' }, { kind: 'app', userId: 1 }, memoryStorage(), true).wipe).toBe(true);
    expect(settleAuthCheck(asUser, login, memoryStorage()).wipe).toBe(false);
    expect(settleAuthCheck({ kind: 'network-error' }, { kind: 'checking' }, memoryStorage()).wipe).toBe(false);
    expect(settleAuthCheck({ kind: 'http-error', message: 'x' }, { kind: 'app', userId: 1 }, memoryStorage()).wipe).toBe(false);
  });

  test("an app that opens for a different login wipes the old login's copy first; the same login keeps it", () => {
    const asUser = (id: number): AuthCheck => ({ kind: 'status', status: status({ user: { id, username: 'u', role: 'admin' } }), sentToken: 't' });
    // Another tab signed in as someone else while this one showed the app.
    expect(settleAuthCheck(asUser(2), { kind: 'app', userId: 1 }, memoryStorage())).toEqual({
      view: { kind: 'app', userId: 2 },
      remount: true,
      wipe: true,
      session: 'started',
    });
    // Auth switched off in place: the copy was a login's.
    expect(settleAuthCheck({ kind: 'status', status: status({ authEnabled: false }), sentToken: null }, { kind: 'app', userId: 1 }, memoryStorage()).wipe).toBe(true);
    expect(settleAuthCheck(asUser(1), { kind: 'app', userId: 1 }, memoryStorage()).wipe).toBe(false);
    // Auth switched on in place (the copy was no login's), or the first login of the page: nothing to drop.
    expect(settleAuthCheck(asUser(1), { kind: 'app', userId: null }, memoryStorage()).wipe).toBe(false);
    expect(settleAuthCheck(asUser(1), { kind: 'checking' }, memoryStorage()).wipe).toBe(false);
  });

  test('session transitions for the WebMCP bridge: in-place login starts, losing the app ends, the page load is neither', () => {
    const asUser = (id: number): AuthCheck => ({ kind: 'status', status: status({ user: { id, username: 'u', role: 'admin' } }), sentToken: 't' });
    const noLogin: AuthCheck = { kind: 'status', status: status({}), sentToken: 'dead' };
    // AuthGate signs the person back in without a reload.
    expect(settleAuthCheck(asUser(1), login, memoryStorage()).session).toBe('started');
    // Another tab signed in as someone else.
    expect(settleAuthCheck(asUser(2), { kind: 'app', userId: 1 }, memoryStorage()).session).toBe('started');
    // The same login confirmed again, or the first check of the page (the bridge syncs on its own load).
    expect(settleAuthCheck(asUser(1), { kind: 'app', userId: 1 }, memoryStorage()).session).toBeNull();
    expect(settleAuthCheck(asUser(1), { kind: 'checking' }, memoryStorage()).session).toBeNull();
    // Expired, logged out elsewhere, revoked.
    expect(settleAuthCheck(noLogin, { kind: 'app', userId: 1 }, memoryStorage()).session).toBe('ended');
    // Already on the login form: nothing new to tell.
    expect(settleAuthCheck(noLogin, { kind: 'login', sessionEnded: true }, memoryStorage()).session).toBeNull();
  });

  test('a token the status check reports as no login is forgotten, unless another tab replaced it', () => {
    const dead: AuthCheck = { kind: 'status', status: status({}), sentToken: 'dead' };
    const same = memoryStorage({ [AUTH_TOKEN_KEY]: 'dead' });
    settleAuthCheck(dead, { kind: 'app', userId: 1 }, same);
    expect(same.data.has(AUTH_TOKEN_KEY)).toBe(false);
    const replaced = memoryStorage({ [AUTH_TOKEN_KEY]: 'fresh' });
    settleAuthCheck(dead, { kind: 'app', userId: 1 }, replaced);
    expect(replaced.data.get(AUTH_TOKEN_KEY)).toBe('fresh');
  });
});

describe('other tabs and bursts', () => {
  test('a storage event for the token (or a cleared store) is a session change; others are not', () => {
    expect(isSessionStorageChange(AUTH_TOKEN_KEY)).toBe(true);
    expect(isSessionStorageChange(null)).toBe(true);
    expect(isSessionStorageChange('wilson_mirror_profile')).toBe(false);
  });

  test('coalesced: a burst of 401s costs at most two status checks', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const check = coalesced(async () => {
      runs++;
      if (runs === 1) await gate;
    });
    const burst = Array.from({ length: 10 }, () => check());
    release();
    await Promise.all(burst);
    expect(runs).toBe(2);
    await check();
    expect(runs).toBe(3);
  });

  test('coalesced: a failing run does not wedge later calls', async () => {
    let runs = 0;
    const check = coalesced(async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
    });
    await expect(check()).rejects.toThrow('boom');
    await check();
    expect(runs).toBe(2);
  });
});

describe('every UI token reader goes through authSession', () => {
  const uiSrc = join(import.meta.dir, '../dashboard/ui/src');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }
  const read = (rel: string) => readFileSync(join(uiSrc, rel), 'utf8');

  test("only lib/authSession.ts names the token key", () => {
    const offenders = files(uiSrc)
      .filter((p) => !p.endsWith(join('lib', 'authSession.ts')))
      .filter((p) => /wilson_auth_token|oa_token/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('api(), authedFetch() and the mirror sync report a 401', () => {
    const api = read('api.ts');
    expect(api.match(/res\.status === 401\) reportUnauthorized\(path, token\)/g)?.length).toBe(2);
    expect(read('store/mirror-client.ts')).toContain('if (res.status === 401) reportUnauthorized(path, token);');
    // The tax export used a bare fetch with its own token read; it goes through authedFetch now.
    expect(read('tabs/ChatTab.tsx')).toContain('await authedFetch(`/api/export/tax?');
  });

  test('the app only mounts behind the gate', () => {
    expect(read('main.tsx')).toContain('<AuthGate />');
    expect(read('main.tsx')).not.toContain('<App />');
  });
});

describe('against the real server', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) stopDashboardServer(s);
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, base: `http://localhost:${server.port}` };
  }
  const json = { 'Content-Type': 'application/json' };

  async function login(base: string, username: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username, password }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  /** What the gate's status check sees with `token`. */
  async function check(base: string, token: string | null): Promise<AuthCheck> {
    const res = await fetch(`${base}/api/auth/status`, { headers: bearerHeader(token) });
    return { kind: 'status', status: (await res.json()) as AuthStatusResponse, sentToken: token };
  }

  async function withAdmin() {
    const env = await start();
    await createUser(env.db, 'owner', 'ownerpass1', 'admin');
    enableAuth(env.db);
    return env;
  }

  test('a new browser (no token) gets the login form; logging in loads the app', async () => {
    const { base } = await withAdmin();
    expect(authGateView(await check(base, null))).toEqual({ kind: 'login', sessionEnded: false });
    const token = await login(base, 'owner', 'ownerpass1');
    const { view, remount } = settleAuthCheck(await check(base, token), { kind: 'login', sessionEnded: false }, memoryStorage({ [AUTH_TOKEN_KEY]: token }));
    expect(view).toMatchObject({ kind: 'app' });
    expect(remount).toBe(true);
    expect((await fetch(`${base}/api/accounts`, { headers: bearerHeader(token) })).status).toBe(200);
  });

  test('a wrong password is a 401 on a public route: shown on the form, not treated as a lost session', async () => {
    const { base } = await withAdmin();
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'owner', password: 'nope' }) });
    expect(res.status).toBe(401);
    expect(reportUnauthorized('/api/auth/login', null, memoryStorage())).toBe(false);
  });

  test('after logout the old token is refused (401) and the gate returns to the login form', async () => {
    const { base } = await withAdmin();
    const token = await login(base, 'owner', 'ownerpass1');
    expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: bearerHeader(token) })).status).toBe(200);
    expect((await fetch(`${base}/api/accounts`, { headers: bearerHeader(token) })).status).toBe(401);
    const storage = memoryStorage({ [AUTH_TOKEN_KEY]: token });
    expect(reportUnauthorized('/api/accounts', token, storage)).toBe(true);
    expect(storage.data.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(settleAuthCheck(await check(base, null), { kind: 'app', userId: 1 }, storage).view).toEqual({ kind: 'login', sessionEnded: true });
  });

  test('an expired session: 401 on data routes, "session ended" login on the status check', async () => {
    const { db, base } = await withAdmin();
    const token = await login(base, 'owner', 'ownerpass1');
    db.prepare("UPDATE dashboard_sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = @token").run({ token });
    expect((await fetch(`${base}/api/summary`, { headers: bearerHeader(token) })).status).toBe(401);
    const storage = memoryStorage({ [AUTH_TOKEN_KEY]: token });
    const { view } = settleAuthCheck(await check(base, token), { kind: 'checking' }, storage);
    expect(view).toEqual({ kind: 'login', sessionEnded: true });
    expect(storage.data.has(AUTH_TOKEN_KEY)).toBe(false);
  });

  test('a deactivated user is sent back to login, and cannot log in again', async () => {
    const { db, base } = await withAdmin();
    const viewer = await createUser(db, 'viewer', 'viewerpass1', 'viewer');
    const token = await login(base, 'viewer', 'viewerpass1');
    expect(deactivateUser(db, viewer.id)).toBe(true);
    expect((await fetch(`${base}/api/accounts`, { headers: bearerHeader(token) })).status).toBe(401);
    expect(authGateView(await check(base, token))).toEqual({ kind: 'login', sessionEnded: true });
    const again = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'viewer', password: 'viewerpass1' }) });
    expect(again.status).toBe(401);
  });

  test('auth on with zero users: the gate offers setup, and the server still allows it exactly once', async () => {
    const { db, base } = await start();
    enableAuth(db); // the flag set without an admin (PATCH /api/auth/config refuses this, #157)
    expect((await fetch(`${base}/api/accounts`)).status).toBe(401);
    expect(authGateView(await check(base, null))).toEqual({ kind: 'setup' });
    const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'owner', password: 'ownerpass1' }) });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(authGateView(await check(base, token))).toMatchObject({ kind: 'app' });
    const second = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'x', password: 'xpass12345' }) });
    expect(second.status).toBe(400);
    expect(authGateView(await check(base, null))).toEqual({ kind: 'login', sessionEnded: false });
  });

  test('users exist but no active admin: a viewer can still log in (read-only); with nobody active, login is the only screen and setup stays closed', async () => {
    const { db, base } = await withAdmin();
    const owner = db.prepare("SELECT id FROM dashboard_users WHERE username = 'owner'").get() as { id: number };
    await createUser(db, 'viewer', 'viewerpass1', 'viewer');
    db.prepare('UPDATE dashboard_users SET is_active = 0 WHERE id = @id').run({ id: owner.id }); // raw: deactivateUser refuses the last admin
    const token = await login(base, 'viewer', 'viewerpass1');
    expect(authGateView(await check(base, token))).toMatchObject({ kind: 'app' });

    const viewer = db.prepare("SELECT id FROM dashboard_users WHERE username = 'viewer'").get() as { id: number };
    deactivateUser(db, viewer.id);
    expect(authGateView(await check(base, null))).toEqual({ kind: 'login', sessionEnded: false });
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'x', password: 'xpass12345' }) });
    expect(setup.status).toBe(400);
  });

  test('two tabs share one token: logging out in one makes the other refused on its next request', async () => {
    const { base } = await withAdmin();
    const token = await login(base, 'owner', 'ownerpass1');
    // Tab A logs out (revokes the shared token, removes the key); tab B's storage event triggers a re-check.
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: bearerHeader(token) });
    const tabB = memoryStorage(); // the key is already gone in the shared storage
    expect(isSessionStorageChange(AUTH_TOKEN_KEY)).toBe(true);
    expect(settleAuthCheck(await check(base, readAuthToken(tabB)), { kind: 'app', userId: 1 }, tabB).view).toEqual({ kind: 'login', sessionEnded: true });
    // And had it fired a request first with the old token, that is a 401 too.
    expect((await fetch(`${base}/api/summary`, { headers: bearerHeader(token) })).status).toBe(401);
  });
});
