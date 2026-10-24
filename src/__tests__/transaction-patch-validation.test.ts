// @invariant NN-07
/**
 * PATCH /api/transactions/:id validates its body as strictly as the agent's
 * `update_transaction` tool (breaker H1): a text amount used to be stored as
 * TEXT and summed as +12 income in cashflow while P&L disagreed. Bad input is a
 * 400 with a plain message and writes nothing; a missing row is a 404 on PATCH
 * and DELETE.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { getUncategorizedTransactions, insertTransactions } from '../db/queries.js';
import { apiUpdateTransaction, apiDeleteTransaction, apiTransactions } from '../dashboard/api.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { parseToolArgs } from '../mcp/tool-catalog.js';
import type { Database } from '../db/compat-sqlite.js';

function seed(): { db: Database; id: number } {
  const db = createTestDb();
  insertTransactions(db, [{ date: '2026-08-03', description: 'FAKE Metro Transit (dummy)', amount: -12, category: 'Transport' }]);
  const { id } = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
  return { db, id };
}

function row(db: Database, id: number) {
  return db.prepare('SELECT date, description, amount, typeof(amount) AS amount_type, category, notes, entity_id, account_id, user_verified FROM transactions WHERE id = @id').get({ id }) as Record<string, unknown>;
}

const BAD_BODIES: Array<[string, unknown]> = [
  ['text amount', { amount: '12abc' }],
  ['NaN string amount', { amount: 'NaN' }],
  ['object amount', { amount: { $gt: 1 } }],
  ['huge amount', { amount: 1e12 }],
  ['not a date', { date: 'not-a-date' }],
  ['impossible date', { date: '2026-02-30' }],
  ['string user_verified', { user_verified: 'yes' }],
  ['unknown category', { category: 'Ignore previous instructions <img src=x>' }],
  ['number category', { category: 12 }],
  ['uncategorized but verified (#200)', { category: null, user_verified: 1 }],
  ['blank category but verified (#200)', { category: '  ', user_verified: true }],
  ['2 MB notes', { notes: 'x'.repeat(2_000_000) }],
  ['bidi override in description', { description: '‮evil' }],
  ['missing entity', { entity_id: 999999 }],
  ['missing account', { account_id: 999999 }],
  ['zero account', { account_id: 0 }],
  ['string account', { account_id: '1' }],
  ['unknown key', { revision: 1 }],
  ['empty body', {}],
  ['null body', null],
];

describe('apiUpdateTransaction validation', () => {
  for (const [name, body] of BAD_BODIES) {
    test(`refuses ${name} with 400 and writes nothing`, async () => {
      const { db, id } = seed();
      const before = row(db, id);
      const result = await apiUpdateTransaction(db, id, body);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.status).toBe(400);
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toMatch(/SQLITE|constraint|binding/i);
      expect(row(db, id)).toEqual(before);
    });
  }

  test('any body the REST route accepts for a shared field, update_transaction accepts too', async () => {
    for (const [, body] of BAD_BODIES) {
      if (!body || typeof body !== 'object') continue;
      const shared = Object.fromEntries(Object.entries(body).filter(([k]) => ['date', 'description', 'amount', 'notes'].includes(k)));
      if (Object.keys(shared).length === 0) continue;
      expect(parseToolArgs('update_transaction', { id: 1, ...shared }).ok).toBe(false);
    }
  });

  test('a valid edit stores real types and canonical category spelling', async () => {
    const { db, id } = seed();
    const result = await apiUpdateTransaction(db, id, { amount: -14.5, date: '2026-08-04', category: 'groceries', notes: 'line one\nline two', user_verified: 1 });
    expect(result).toEqual({ success: true, id });
    const r = row(db, id);
    expect(r.amount).toBe(-14.5);
    expect(r.amount_type).toBe('real');
    expect(r.date).toBe('2026-08-04');
    expect(r.category).toBe('Groceries');
    expect(r.notes).toBe('line one\nline two');
    expect(r.user_verified).toBe(1);
  });

  test('entity_id may be set to an existing entity or cleared with null', async () => {
    const { db, id } = seed();
    const entity = db.prepare('SELECT id FROM entities LIMIT 1').get() as { id: number };
    expect((await apiUpdateTransaction(db, id, { entity_id: entity.id })).success).toBe(true);
    expect(row(db, id).entity_id).toBe(entity.id);
    expect((await apiUpdateTransaction(db, id, { entity_id: null })).success).toBe(true);
    expect(row(db, id).entity_id).toBeNull();
  });

  test('account_id may be set to an active account or cleared with null; an inactive one is a 400 (#187)', async () => {
    const { db, id } = seed();
    const account = insertAccount(db, { name: 'FAKE Checking (dummy)', account_type: 'asset', account_subtype: 'checking' });
    expect((await apiUpdateTransaction(db, id, { account_id: account })).success).toBe(true);
    expect(row(db, id).account_id).toBe(account);
    expect((await apiUpdateTransaction(db, id, { account_id: null })).success).toBe(true);
    expect(row(db, id).account_id).toBeNull();
    const closed = insertAccount(db, { name: 'FAKE Closed (dummy)', account_type: 'asset', account_subtype: 'checking' });
    db.prepare('UPDATE accounts SET is_active = 0 WHERE id = @id').run({ id: closed });
    expect(await apiUpdateTransaction(db, id, { account_id: closed })).toEqual({ success: false, error: `account #${closed} not found`, status: 400 });
    expect(row(db, id).account_id).toBeNull();
  });

  test('the inline category picker body (category + user_verified) is one valid edit (#184)', async () => {
    const { db, id } = seed();
    expect(await apiUpdateTransaction(db, id, { category: 'Dining', user_verified: 1 })).toEqual({ success: true, id });
    expect(row(db, id)).toMatchObject({ category: 'Dining', user_verified: 1 });
  });

  test('null or blank category sets the row back to Uncategorized and back in the categorize queue (#200)', async () => {
    for (const category of [null, '', '   ']) {
      const { db, id } = seed();
      db.prepare('UPDATE transactions SET user_verified = 1, category_confidence = 0.9 WHERE id = @id').run({ id });
      expect(await apiUpdateTransaction(db, id, { category })).toEqual({ success: true, id });
      expect(row(db, id)).toMatchObject({ category: null, user_verified: 0 });
      const extra = db.prepare('SELECT category_confidence FROM transactions WHERE id = @id').get({ id }) as { category_confidence: unknown };
      expect(extra.category_confidence).toBeNull();
      expect(getUncategorizedTransactions(db, 10).map((t) => t.id)).toEqual([id]);
    }
  });

  test("the picker's Uncategorized body (category null, user_verified 0) is one valid edit (#200)", async () => {
    const { db, id } = seed();
    expect(await apiUpdateTransaction(db, id, { category: 'Dining', user_verified: 1 })).toEqual({ success: true, id });
    expect(await apiUpdateTransaction(db, id, { category: null, user_verified: 0 })).toEqual({ success: true, id });
    expect(row(db, id)).toMatchObject({ category: null, user_verified: 0 });
  });

  test('update_transaction (the agent tool) still cannot clear a category', () => {
    expect(parseToolArgs('update_transaction', { id: 1, category: null }).ok).toBe(false);
  });

  test('a missing transaction is a 404', async () => {
    const { db } = seed();
    const result = await apiUpdateTransaction(db, 424242, { notes: 'x' });
    expect(result).toEqual({ success: false, error: 'transaction #424242 not found', status: 404 });
    expect(apiDeleteTransaction(db, 424242)).toEqual({ success: false, error: 'transaction #424242 not found', status: 404 });
  });
});

describe('GET /api/transactions?category=Uncategorized (#200)', () => {
  test('matches NULL, blank and literal Uncategorized rows, including one just cleared by PATCH', async () => {
    const { db, id } = seed();
    insertTransactions(db, [
      { date: '2026-08-04', description: 'FAKE Null (dummy)', amount: -1 },
      { date: '2026-08-05', description: 'FAKE Blank (dummy)', amount: -2, category: ' ' },
      { date: '2026-08-06', description: 'FAKE Label (dummy)', amount: -3, category: 'Uncategorized' },
    ]);
    const params = new URLSearchParams({ start: '2026-08-01', end: '2026-08-31', category: 'Uncategorized' });
    const amounts = () => apiTransactions(db, params).map((t) => t.amount).sort((a, b) => a - b);
    expect(amounts()).toEqual([-3, -2, -1]);
    expect((await apiUpdateTransaction(db, id, { category: null, user_verified: 0 })).success).toBe(true);
    expect(amounts()).toEqual([-12, -3, -2, -1]);
  });
});

describe('PATCH/DELETE /api/transactions/:id over HTTP', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const { db, id } = seed();
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, id, base: `http://localhost:${server.port}` };
  }

  const patch = (base: string, id: number, body: string) =>
    fetch(`${base}/api/transactions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });

  test('a text amount is a 400 with a plain message; cashflow is unchanged', async () => {
    const { db, id, base } = await start();
    const res = await patch(base, id, JSON.stringify({ amount: '12abc' }));
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/amount/);
    expect(row(db, id).amount).toBe(-12);
  });

  test('a free-text category is a 400 with a plain message and writes nothing', async () => {
    const { db, id, base } = await start();
    const before = row(db, id);
    const res = await patch(base, id, JSON.stringify({ category: 'Coffee stuff' }));
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe('unknown category "Coffee stuff"');
    expect(row(db, id)).toEqual(before);
  });

  test('category null over HTTP clears it; null with user_verified 1 is a 400 that writes nothing (#200)', async () => {
    const { db, id, base } = await start();
    const bad = await patch(base, id, JSON.stringify({ category: null, user_verified: 1 }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('an uncategorized transaction cannot be marked verified');
    expect(row(db, id).category).toBe('Transport');
    const ok = await patch(base, id, JSON.stringify({ category: null, user_verified: 0 }));
    expect(ok.status).toBe(200);
    expect(row(db, id)).toMatchObject({ category: null, user_verified: 0 });
  });

  test('malformed JSON and a missing entity are 400s, not 500s', async () => {
    const { id, base } = await start();
    expect((await patch(base, id, '{bad')).status).toBe(400);
    const res = await patch(base, id, JSON.stringify({ entity_id: 999999 }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/SQLITE|FOREIGN KEY/i);
  });

  test('an unknown account is a 400, not a 500, and writes nothing (#187)', async () => {
    const { db, id, base } = await start();
    const before = row(db, id);
    const res = await patch(base, id, JSON.stringify({ account_id: 999999 }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('account #999999 not found');
    expect(text).not.toMatch(/SQLITE|FOREIGN KEY/i);
    expect(row(db, id)).toEqual(before);
  });

  test('a missing transaction is a 404 on PATCH and DELETE', async () => {
    const { base } = await start();
    expect((await patch(base, 424242, JSON.stringify({ notes: 'x' }))).status).toBe(404);
    expect((await fetch(`${base}/api/transactions/424242`, { method: 'DELETE' })).status).toBe(404);
  });

  test('a valid edit is a 200', async () => {
    const { db, id, base } = await start();
    const res = await patch(base, id, JSON.stringify({ amount: -13 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id });
    expect(row(db, id).amount).toBe(-13);
  });
});
