// @invariant NN-04
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { getAccounts } from '../db/net-worth-queries.js';

// POST /api/accounts (#199): the dashboard's "Add account" and the importer's "New account…".

const post = (base: string, body: unknown, token?: string) =>
  fetch(base + '/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/accounts', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    return { db, base: `http://localhost:${result.server.port}` };
  }

  async function login(base: string, username: string, password: string): Promise<string> {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return (await res.json()).token;
  }

  test('creates the account with the type its subtype implies, trimmed, and GET lists it', async () => {
    const { db, base } = await start();
    const res = await post(base, { name: '  FAKE Joint checking (dummy)  ', accountSubtype: 'checking', institution: ' FAKE Bank ', accountNumberLast4: '1234' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.account).toMatchObject({
      name: 'FAKE Joint checking (dummy)',
      account_type: 'asset',
      account_subtype: 'checking',
      institution: 'FAKE Bank',
      account_number_last4: '1234',
      is_active: 1,
    });

    const card = await (await post(base, { name: 'FAKE card (dummy)', accountSubtype: 'credit_card' })).json();
    expect(card.account.account_type).toBe('liability');
    expect(card.account.institution).toBeNull();

    const list = (await (await fetch(base + '/api/accounts')).json()) as { id: number; name: string }[];
    expect(list.map((a) => a.name).sort()).toEqual(['FAKE Joint checking (dummy)', 'FAKE card (dummy)']);
    expect(getAccounts(db)).toHaveLength(2);
  });

  test.each([
    ['missing name', { accountSubtype: 'checking' }],
    ['blank name', { name: '   ', accountSubtype: 'checking' }],
    ['only invisible characters', { name: '​\u0007', accountSubtype: 'checking' }],
    ['name too long', { name: 'x'.repeat(81), accountSubtype: 'checking' }],
    ['non-string name', { name: { a: 1 }, accountSubtype: 'checking' }],
    ['missing subtype', { name: 'FAKE (dummy)' }],
    ['unknown subtype', { name: 'FAKE (dummy)', accountSubtype: 'piggy_bank' }],
    ['account type instead of subtype', { name: 'FAKE (dummy)', accountSubtype: 'asset' }],
    ['last4 not 4 digits', { name: 'FAKE (dummy)', accountSubtype: 'checking', accountNumberLast4: '12a4' }],
    ['array body', [1, 2]],
    ['invalid JSON', '{nope'],
  ] as [string, unknown][])('400 and nothing written: %s', async (_label, body) => {
    const { db, base } = await start();
    const res = await post(base, body);
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(getAccounts(db)).toHaveLength(0);
  });

  test('an 80-character name is accepted', async () => {
    const { base } = await start();
    const res = await post(base, { name: 'y'.repeat(80), accountSubtype: 'savings' });
    expect(res.status).toBe(201);
  });

  test('with auth on: no token 401, viewer 403, admin 201', async () => {
    const { db, base } = await start();
    await createUser(db, 'admin', 'adminpass', 'admin');
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);
    const adminToken = await login(base, 'admin', 'adminpass');
    const viewerToken = await login(base, 'viewer', 'viewerpass');
    const body = { name: 'FAKE account (dummy)', accountSubtype: 'checking' };

    expect((await post(base, body)).status).toBe(401);
    expect((await post(base, body, viewerToken)).status).toBe(403);
    expect(getAccounts(db)).toHaveLength(0);

    const res = await post(base, body, adminToken);
    expect(res.status).toBe(201);
    expect(getAccounts(db)).toHaveLength(1);
  });
});
