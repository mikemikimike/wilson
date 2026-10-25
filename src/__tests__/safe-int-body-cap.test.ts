import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { Database } from '../db/compat-sqlite.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { outOfRangeInt } from '../dashboard/spending-params.js';
import { checkTransactionListParams } from '../dashboard/transactions-query.js';
import { JSON_BODY_MAX_BYTES, TRACE_BODY_MAX_BYTES, bodyCapFor } from '../dashboard/write-recheck.js';
import { createMirrorSchema } from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { MirrorTestBinding } from './mirror-helpers.js';

/**
 * #197: a numeric query param past 2^53 is a 400 `{ error: '<name> is out of range' }`, never a SQLite 500, on the
 * server and in the offline mirror alike; and a write's body over 1 MB is a 413 before any route parses it, while the
 * statement import route keeps Bun's own limit.
 */

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';
const LEAK = /\/Users\/|\/private\/|node_modules|\.ts:\d+|\bat \w+ \(|SQLite|SQLITE_|datatype mismatch/;
const HUGE = ['99999999999999999999999', '9007199254740993', '-99999999999999999999999'];
/** In range, or no number at all: the lenient parsers' old answers stand. */
const FINE = ['abc', '', '-1', '0', '10', '9007199254740991'];

describe('outOfRangeInt / checkTransactionListParams', () => {
  test('a value past 2^53 names its param; absent, empty, non-numeric and safe values pass', () => {
    for (const v of HUGE) {
      expect(outOfRangeInt(new URLSearchParams({ limit: v }), 'limit')).toEqual({ status: 400, error: 'limit is out of range' });
    }
    for (const v of FINE) expect(outOfRangeInt(new URLSearchParams({ limit: v }), 'limit')).toBeNull();
    expect(outOfRangeInt(new URLSearchParams(), 'limit')).toBeNull();
    // The first offending param in the order given is the one reported.
    expect(outOfRangeInt(new URLSearchParams({ b: HUGE[0], a: HUGE[0] }), 'a', 'b')?.error).toBe('a is out of range');
  });

  test('the transactions list checks limit, offset, accountId and entityId', () => {
    for (const name of ['limit', 'offset', 'accountId', 'entityId']) {
      expect(checkTransactionListParams(new URLSearchParams({ [name]: HUGE[0] }))?.error).toBe(`${name} is out of range`);
    }
    expect(checkTransactionListParams(new URLSearchParams({ limit: '100', offset: '5', accountId: '1', entityId: '2' }))).toBeNull();
  });

  test('the mirror answers the same BadRequest the server sends, and still pages a sane query', async () => {
    const mirror = new MirrorTestBinding(new Database(':memory:'));
    await createMirrorSchema(mirror);
    expect(await serveApiPath(mirror, `/api/transactions?offset=${HUGE[0]}`)).toEqual({ status: 400, error: 'offset is out of range' });
    expect(await serveApiPath(mirror, '/api/transactions?limit=5&offset=0')).toEqual([]);
  });
});

describe('dashboard server: >2^53 params and the body cap', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) { try { stopDashboardServer(s); } catch { /* */ } }
    servers.length = 0;
    closeAll();
  });

  async function start(opts: { auth?: boolean } = {}) {
    const db = createTestDb();
    if (opts.auth) {
      await createUser(db, 'admin1', 'password123', 'admin');
      enableAuth(db);
    }
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const page = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-Wilson-Agent-Session': SESSION };
    return { db, base, page };
  }

  test('GET /api/transactions with offset, limit, accountId or entityId past 2^53 is a 400, not a 500', async () => {
    const { base, page } = await start();
    for (const name of ['limit', 'offset', 'accountId', 'entityId']) {
      for (const v of HUGE) {
        const res = await fetch(`${base}/api/transactions?${name}=${v}`, { headers: page });
        const text = await res.text();
        expect(`${name}=${v} ${res.status}`).toBe(`${name}=${v} 400`);
        expect(JSON.parse(text)).toEqual({ error: `${name} is out of range` });
        expect(text).not.toMatch(LEAK);
      }
      for (const v of FINE) {
        const res = await fetch(`${base}/api/transactions?${name}=${v}`, { headers: page });
        expect(`${name}=${v} ${res.status}`).toBe(`${name}=${v} 200`);
      }
    }
  });

  test('GET /api/reviews with a limit past 2^53 is a 400, not a 500', async () => {
    const { base, page } = await start();
    for (const v of HUGE) {
      const res = await fetch(`${base}/api/reviews?limit=${v}`, { headers: page });
      const text = await res.text();
      expect(`${v} ${res.status}`).toBe(`${v} 400`);
      expect(JSON.parse(text)).toEqual({ error: 'limit is out of range' });
      expect(text).not.toMatch(LEAK);
    }
    for (const v of FINE) {
      const res = await fetch(`${base}/api/reviews?limit=${v}`, { headers: page });
      expect(`${v} ${res.status}`).toBe(`${v} 200`);
    }
  });

  test('a JSON write body over 1 MB is a 413 before the route runs, declared or streamed', async () => {
    const { db, base, page } = await start();
    const content = 'x'.repeat(JSON_BODY_MAX_BYTES);
    const big = JSON.stringify({ memoryType: 'context', content });
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const before = count();

    // Declared length over the cap.
    const declared = await fetch(`${base}/api/memories`, { method: 'POST', headers: page, body: big });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'request body is larger than 1 MB' });

    // No Content-Length (chunked): counted while it streams.
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) c.enqueue(bytes.slice(i, i + 64 * 1024));
        c.close();
      },
    });
    const streamed = await fetch(`${base}/api/memories`, { method: 'POST', headers: page, body: stream });
    expect(streamed.status).toBe(413);

    // PATCH and DELETE go through the same read.
    expect((await fetch(`${base}/api/transactions/1`, { method: 'PATCH', headers: page, body: big })).status).toBe(413);
    expect((await fetch(`${base}/api/memories/1`, { method: 'DELETE', headers: page, body: big })).status).toBe(413);
    expect(count()).toBe(before);

    // A normal write is unaffected, and so is one just under the cap.
    const ok = await fetch(`${base}/api/memories`, { method: 'POST', headers: page, body: JSON.stringify({ memoryType: 'context', content: 'remember this' }) });
    expect(ok.status).toBe(200);
    const nearCap = JSON.stringify({ memoryType: 'context', content: 'y'.repeat(JSON_BODY_MAX_BYTES - 100) });
    expect(new TextEncoder().encode(nearCap).length).toBeLessThanOrEqual(JSON_BODY_MAX_BYTES);
    expect((await fetch(`${base}/api/memories`, { method: 'POST', headers: page, body: nearCap })).status).not.toBe(413);
  });

  test('the cap holds on the public auth routes too (no login to re-check)', async () => {
    const { base, page } = await start({ auth: true });
    const big = JSON.stringify({ username: 'admin1', password: 'p'.repeat(JSON_BODY_MAX_BYTES) });
    expect((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: page, body: big })).status).toBe(413);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: page, body: JSON.stringify({ username: 'admin1', password: 'password123' }) });
    expect(login.status).toBe(200);
  });

  test('a statement import over 1 MB is not capped (it keeps Bun\'s own limit)', async () => {
    expect(bodyCapFor('/api/import')).toBeUndefined();
    expect(bodyCapFor('/api/memories')).toBe(JSON_BODY_MAX_BYTES);
    expect(bodyCapFor('/api/demo/trace/step')).toBe(TRACE_BODY_MAX_BYTES);
    const { base, page } = await start();
    const transactions = Array.from({ length: 6000 }, (_, i) => ({
      date: '2026-03-10',
      description: `STATEMENT ROW ${i} ${'d'.repeat(160)}`,
      amount: -(i + 1),
      external_id: `ext-${i}`,
    }));
    const body = JSON.stringify({ filename: 'big-statement.csv', bank: 'Big Bank', transactions });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const res = await fetch(`${base}/api/import`, { method: 'POST', headers: page, body });
    expect(res.status).toBe(200);
    expect((await res.json()).transactionsImported).toBe(6000);
  });
});
