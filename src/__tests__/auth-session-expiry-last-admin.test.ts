import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import {
  LastAdminError, cleanExpiredSessions, createUser, deactivateUser, enableAuth, getUser, validateToken, verifyLogin,
} from '../dashboard/auth.js';

/**
 * Two server-side auth bugs: session expiry compared an ISO expires_at against datetime('now') as text (so a
 * session lived ~24h past expiry), and the last active admin could be deactivated, locking everyone out.
 */

describe('session expiry compares instants, not text', () => {
  async function sessionWithExpiry(offsetMs: number) {
    const db = createTestDb();
    await createUser(db, 'owner', 'ownerpass1', 'admin');
    const login = await verifyLogin(db, 'owner', 'ownerpass1');
    const expires = new Date(Date.now() + offsetMs).toISOString();
    db.prepare('UPDATE dashboard_sessions SET expires_at = @expires WHERE token = @token').run({ expires, token: login!.token });
    return { db, token: login!.token };
  }

  test('a session that expired 1 minute ago is rejected', async () => {
    const { db, token } = await sessionWithExpiry(-60_000);
    expect(validateToken(db, token)).toBeNull();
  });

  test('a session expiring in 1 minute is accepted', async () => {
    const { db, token } = await sessionWithExpiry(60_000);
    expect(validateToken(db, token)?.username).toBe('owner');
  });

  test('legacy space-separated expires_at values still compare correctly', async () => {
    const { db, token } = await sessionWithExpiry(0);
    db.prepare("UPDATE dashboard_sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = @token").run({ token });
    expect(validateToken(db, token)).toBeNull();
  });

  test('cleanExpiredSessions purges by the same rule', async () => {
    const { db, token } = await sessionWithExpiry(-60_000);
    const live = await verifyLogin(db, 'owner', 'ownerpass1');
    expect(cleanExpiredSessions(db)).toBe(1);
    expect(validateToken(db, token)).toBeNull();
    expect(validateToken(db, live!.token)).not.toBeNull();
  });

  test('a session expiring in 1 minute survives cleanup', async () => {
    const { db, token } = await sessionWithExpiry(60_000);
    expect(cleanExpiredSessions(db)).toBe(0);
    expect(validateToken(db, token)).not.toBeNull();
  });
});

describe('last active admin cannot be removed', () => {
  test('deactivateUser throws for the only active admin and changes nothing', async () => {
    const db = createTestDb();
    const admin = await createUser(db, 'owner', 'ownerpass1', 'admin');
    expect(() => deactivateUser(db, admin.id)).toThrow(LastAdminError);
    expect(getUser(db, admin.id)!.is_active).toBeTruthy();
  });

  test('a second admin makes the first removable; a viewer never counts as an admin', async () => {
    const db = createTestDb();
    const a = await createUser(db, 'a', 'passwordA1', 'admin');
    await createUser(db, 'v', 'passwordV1', 'viewer');
    expect(() => deactivateUser(db, a.id)).toThrow(LastAdminError);
    const b = await createUser(db, 'b', 'passwordB1', 'admin');
    expect(deactivateUser(db, a.id)).toBe(true);
    expect(() => deactivateUser(db, b.id)).toThrow(LastAdminError);
  });

  test('a viewer can always be deactivated', async () => {
    const db = createTestDb();
    await createUser(db, 'a', 'passwordA1', 'admin');
    const v = await createUser(db, 'v', 'passwordV1', 'viewer');
    expect(deactivateUser(db, v.id)).toBe(true);
  });
});

describe('DELETE /api/auth/users/:id against the real server', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) stopDashboardServer(s);
    servers.length = 0;
    closeAll();
  });

  const json = { 'Content-Type': 'application/json' };
  async function start() {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, base: `http://localhost:${server.port}` };
  }
  async function login(base: string, username: string, password: string): Promise<Record<string, string>> {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username, password }) });
    return { Authorization: `Bearer ${((await res.json()) as { token: string }).token}` };
  }

  test('an admin deactivating themselves as the last admin gets 409 and stays active', async () => {
    const { db, base } = await start();
    const owner = await createUser(db, 'owner', 'ownerpass1', 'admin');
    enableAuth(db);
    const auth = await login(base, 'owner', 'ownerpass1');
    const res = await fetch(`${base}/api/auth/users/${owner.id}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('last active admin');
    expect(getUser(db, owner.id)!.is_active).toBeTruthy();
    expect((await fetch(`${base}/api/accounts`, { headers: auth })).status).toBe(200);
  });

  test('deleting the last admin with only viewers left is refused too', async () => {
    const { db, base } = await start();
    const owner = await createUser(db, 'owner', 'ownerpass1', 'admin');
    const viewer = await createUser(db, 'v', 'passwordV1', 'viewer');
    enableAuth(db);
    const auth = await login(base, 'owner', 'ownerpass1');
    expect((await fetch(`${base}/api/auth/users/${owner.id}`, { method: 'DELETE', headers: auth })).status).toBe(409);
    expect((await fetch(`${base}/api/auth/users/${viewer.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
  });

  test('with a second admin, one admin can be removed (self included), then the last cannot', async () => {
    const { db, base } = await start();
    const a = await createUser(db, 'a', 'passwordA1', 'admin');
    const b = await createUser(db, 'b', 'passwordB1', 'admin');
    enableAuth(db);
    const authA = await login(base, 'a', 'passwordA1');
    const authB = await login(base, 'b', 'passwordB1');
    expect((await fetch(`${base}/api/auth/users/${a.id}`, { method: 'DELETE', headers: authA })).status).toBe(200);
    expect(getUser(db, a.id)!.is_active).toBeFalsy();
    expect((await fetch(`${base}/api/auth/users/${b.id}`, { method: 'DELETE', headers: authB })).status).toBe(409);
  });

  test('a viewer still cannot delete anyone (403, existing check intact)', async () => {
    const { db, base } = await start();
    const owner = await createUser(db, 'owner', 'ownerpass1', 'admin');
    await createUser(db, 'v', 'passwordV1', 'viewer');
    enableAuth(db);
    const auth = await login(base, 'v', 'passwordV1');
    expect((await fetch(`${base}/api/auth/users/${owner.id}`, { method: 'DELETE', headers: auth })).status).toBe(403);
  });
});
