import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { insertTransactions } from '../db/queries.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';

// Bad request bodies answer 4xx with a plain message, never a 500 that echoes
// parser, TypeError or SQLite text. Anything unexpected is a generic 500.
describe('dashboard error hygiene', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) { try { stopDashboardServer(s); } catch { /* */ } }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return { db, base: `http://localhost:${server.port}` };
  }
  const send = (base: string, method: string, path: string, raw: string) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: raw });

  const JSON_ROUTES: [string, string][] = [
    ['POST', '/api/import'],
    ['POST', '/api/memories'],
    ['POST', '/api/entities'],
    ['PUT', '/api/entities/1'],
    ['PATCH', '/api/transactions/1'],
    ['POST', '/api/reviews/1/correct'],
    ['PUT', '/api/settings/custom-prompt'],
    ['POST', '/api/chat'],
    ['POST', '/api/demo/showdown/cloud'],
  ];

  test('JSON that is not an object is a 400, not a TypeError 500', async () => {
    const { base } = await start();
    for (const raw of ['null', '[]', '5', '"x"']) {
      for (const [method, path] of JSON_ROUTES) {
        const res = await send(base, method, path, raw);
        const text = await res.text();
        expect(`${raw} ${method} ${path} ${res.status}`).toBe(`${raw} ${method} ${path} 400`);
        expect(JSON.parse(text)).toEqual({ error: 'invalid JSON body' });
      }
    }
  });

  test('unparseable JSON is a 400 { error: "invalid JSON body" } on body routes', async () => {
    const { base } = await start();
    for (const [method, path] of JSON_ROUTES) {
      const res = await send(base, method, path, '{bad');
      const text = await res.text();
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 400`);
      expect(JSON.parse(text)).toEqual({ error: 'invalid JSON body' });
    }
  });

  test('validation failures are 400 with a plain message', async () => {
    const { base } = await start();
    const mem = await send(base, 'POST', '/api/memories', '{}');
    expect(mem.status).toBe(400);
    expect((await mem.json()).error).toBe('memoryType and content required');

    const badType = await send(base, 'POST', '/api/memories', JSON.stringify({ memoryType: 'preference', content: 'x' }));
    expect(badType.status).toBe(400);
    expect(JSON.stringify(await badType.json())).not.toMatch(/CHECK|constraint/i);
  });

  test('a non-string fileHash is a 400 import failure, not a TypeError 500', async () => {
    const { base } = await start();
    const res = await send(base, 'POST', '/api/import', JSON.stringify({
      filename: 'a.csv', fileHash: 5,
      transactions: [{ date: '2026-01-15', description: 'X', amount: -1 }],
    }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('is not a function');
  });

  test('unexpected failures answer a generic 500 without SQLite text', async () => {
    const { db, base } = await start();
    insertTransactions(db, [{ date: '2026-01-15', description: 'X', amount: -1 }]);
    const row = db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number };
    // A missing entity is now a validated 400 (PATCH body validation), not a FOREIGN KEY 500.
    const missing = await send(base, 'PATCH', `/api/transactions/${row.id}`, JSON.stringify({ entity_id: 999999 }));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).not.toMatch(/FOREIGN KEY|constraint|SQLITE/i);

    // A genuinely unexpected SQLite failure still answers the generic 500.
    db.exec('DROP TABLE entities');
    const res = await send(base, 'POST', '/api/entities', JSON.stringify({ name: 'x' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
  // Every JSON write route, every typed field: an object, array, number or string where another type is
  // expected is a 400 with a plain message, never a 500 (or a silent coercion into a write).
  type Kind = 'string' | 'number' | 'boolean' | 'array';
  const WRONG: Record<Kind, unknown[]> = {
    string: [{}, [], 5],
    number: [{}, [], 'x'],
    boolean: [{}, [], 'x', 5],
    array: [{}, 'x', 5],
  };
  const FAKE_ROW = { date: '2026-01-15', description: 'FAKE Coffee (dummy)', amount: -4.5 };
  const WRITE_ROUTES: { method: string; path: string; base: Record<string, unknown>; fields: [string, Kind][] }[] = [
    { method: 'POST', path: '/api/auth/setup', base: { username: 'fake-admin', password: 'dummy-pass' }, fields: [['username', 'string'], ['password', 'string']] },
    { method: 'POST', path: '/api/auth/login', base: { username: 'fake-admin', password: 'dummy-pass' }, fields: [['username', 'string'], ['password', 'string']] },
    { method: 'POST', path: '/api/auth/users', base: { username: 'fake-viewer', password: 'dummy-pass', role: 'viewer' }, fields: [['username', 'string'], ['password', 'string'], ['role', 'string']] },
    { method: 'PATCH', path: '/api/auth/config', base: {}, fields: [['auth_enabled', 'boolean']] },
    { method: 'POST', path: '/api/profiles/switch', base: { name: 'test' }, fields: [['name', 'string']] },
    { method: 'PUT', path: '/api/budgets/Groceries', base: { monthlyLimit: 100 }, fields: [['monthlyLimit', 'number']] },
    { method: 'PATCH', path: '/api/transactions/1', base: { notes: 'FAKE note' }, fields: [['description', 'string'], ['amount', 'number'], ['category', 'string'], ['notes', 'string'], ['entity_id', 'number'], ['account_id', 'number']] },
    { method: 'POST', path: '/api/reviews/1/correct', base: { category: 'Groceries' }, fields: [['category', 'string']] },
    { method: 'PATCH', path: '/api/goals/1', base: { status: 'active' }, fields: [['targetAmount', 'number'], ['targetDate', 'string'], ['status', 'string']] },
    { method: 'POST', path: '/api/entities', base: { name: 'FAKE Entity' }, fields: [['name', 'string'], ['description', 'string'], ['color', 'string']] },
    { method: 'PUT', path: '/api/entities/1', base: { name: 'FAKE Entity' }, fields: [['name', 'string'], ['description', 'string'], ['color', 'string']] },
    { method: 'POST', path: '/api/import', base: { filename: 'FAKE.csv', transactions: [FAKE_ROW] }, fields: [['filename', 'string'], ['bank', 'string'], ['fileHash', 'string'], ['accountId', 'number'], ['transactions', 'array']] },
    { method: 'POST', path: '/api/demo/trace/step', base: { step: 'import', filename: 'FAKE.csv', fileHash: 'dummy', transactions: [FAKE_ROW] }, fields: [['step', 'string'], ['filename', 'string'], ['fileHash', 'string'], ['transactions', 'array']] },
    { method: 'POST', path: '/api/demo/autobook/candidates', base: { description: 'FAKE Coffee', importedIds: [1] }, fields: [['description', 'string'], ['importedIds', 'array']] },
    { method: 'POST', path: '/api/memories', base: { memoryType: 'context', content: 'FAKE memory' }, fields: [['memoryType', 'string'], ['content', 'string'], ['category', 'string']] },
    { method: 'PUT', path: '/api/settings/custom-prompt', base: { prompt: 'FAKE prompt' }, fields: [['prompt', 'string']] },
    { method: 'POST', path: '/api/chat', base: { query: 'FAKE question' }, fields: [['query', 'string'], ['sessionId', 'string'], ['mentions', 'array']] },
    { method: 'POST', path: '/api/models', base: { task: 'categorization', model: null }, fields: [['task', 'string'], ['model', 'string']] },
    { method: 'POST', path: '/api/chat/local', base: { query: 'FAKE q', answer: 'FAKE a' }, fields: [['query', 'string'], ['answer', 'string'], ['sessionId', 'string']] },
    { method: 'POST', path: '/api/demo/showdown/cloud', base: {}, fields: [['slug', 'string']] },
    { method: 'POST', path: '/api/demo/showdown/local', base: {}, fields: [['slug', 'string']] },
    { method: 'POST', path: '/api/demo/showdown/browser-trace', base: { model: 'FAKE-model', decisionMs: 5 }, fields: [['model', 'string'], ['decisionMs', 'number'], ['ok', 'boolean'], ['error', 'string']] },
  ];

  test('a wrong-typed field on any JSON write route is a 400 with a plain message, never a 500', async () => {
    const failures: string[] = [];
    for (const route of WRITE_ROUTES) {
      for (const [field, kind] of route.fields) {
        for (const bad of WRONG[kind]) {
          // A fresh server per probe: a probe that wrongly succeeds (an admin created, auth enabled) must not
          // change what the next probe sees.
          const { db, base } = await start();
          insertTransactions(db, [FAKE_ROW]);
          db.prepare("INSERT INTO entities (name, slug) VALUES ('FAKE Entity', 'fake-entity')").run();
          const res = await send(base, route.method, route.path, JSON.stringify({ ...route.base, [field]: bad }));
          const text = await res.text();
          const label = `${route.method} ${route.path} ${field}=${JSON.stringify(bad)}`;
          if (res.status !== 400) failures.push(`${label} -> ${res.status} ${text.slice(0, 120)}`);
          else if (/TypeError|SQLITE|constraint|is not a function|Internal server error/i.test(text)) failures.push(`${label} -> leaky ${text.slice(0, 120)}`);
          closeAll();
          for (const s of servers) { try { stopDashboardServer(s); } catch { /* */ } }
          servers.length = 0;
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
