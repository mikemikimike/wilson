// @invariant NN-01
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
// The default (CommonJS) objects are mutable and shared with `import http from 'http'` / require('http') callers;
// the ESM namespace objects are read-only. Named-import callers keep the original binding (best effort, noted).
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, verifyLogin } from '../dashboard/auth.js';
import { setGlobalStateFile } from '../mcp/global-state.js';
import { initImportTool, csvImportTool } from '../tools/import/csv-import.js';
import { parseChaseCSV } from '../tools/import/parsers/chase.js';
import { parseOfx } from '../tools/import/parsers/ofx.js';
import { parseQif } from '../tools/import/parsers/qif.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * NN-01: with no cloud provider key, OTel endpoint or sync configured, the app makes no outbound request beyond
 * localhost. Every outbound HTTP path this process has (globalThis.fetch, node:http/https request/get) is wrapped to
 * RECORD the target and to REFUSE anything non-loopback, so the test never actually leaves the machine; then the
 * representative local flows run: the dashboard (auth on, as admin) serving its main read routes and a few writes,
 * and the importers on fixtures. Every recorded request must be to localhost / 127.0.0.1 / [::1].
 * The first test is a canary proving the recorder sees (and blocks) a non-local request, so a silent recorder
 * cannot make the invariant pass vacuously. No ML model is loaded (the embedder is the helpers' fake).
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** Env that would legitimately opt the user into egress: removed for the whole file, restored after. */
const OPT_IN_ENV = /(^OTEL_)|(_API_KEY$)|(_ACCESS_TOKEN$)|(^HF_TOKEN$)|(^FIREFLY_)|(^MONARCH_)|(^PLAID_)|(_BASE_URL$)|(^OA_API_URL$)/;

interface Outbound {
  via: string;
  url: string;
  host: string;
}

let recorded: Outbound[] = [];
const savedEnv: Record<string, string> = {};
const realFetch = globalThis.fetch;
const realHttp = { request: http.request, get: http.get };
const realHttps = { request: https.request, get: https.get };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function record(via: string, url: string): boolean {
  const host = hostOf(url);
  recorded.push({ via, url, host });
  return LOOPBACK.has(host);
}

/** Best-effort target of a node:http(s) request(url | options, ...). */
function nodeTarget(proto: 'http' | 'https', args: unknown[]): string {
  const [a, b] = args;
  if (typeof a === 'string') return a;
  if (a instanceof URL) return a.href;
  const o = ((a && typeof a === 'object' ? a : b) ?? {}) as { hostname?: string; host?: string; port?: number; path?: string };
  const host = o.hostname ?? (o.host ?? 'localhost').replace(/:\d+$/, '');
  return `${proto}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}`;
}

function wrapNode(mod: typeof http | typeof https, proto: 'http' | 'https', real: { request: typeof http.request; get: typeof http.get }) {
  const guard = (name: 'request' | 'get') =>
    ((...args: unknown[]) => {
      const target = nodeTarget(proto, args);
      if (!record(`node:${proto}.${name}`, target)) throw new Error(`no-egress test: blocked non-local ${proto} request to ${target}`);
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    }) as typeof http.request;
  (mod as { request: unknown }).request = guard('request');
  (mod as { get: unknown }).get = guard('get');
}

function installRecorder(): void {
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!record('fetch', url)) throw new Error(`no-egress test: blocked non-local fetch to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, realFetch);
  wrapNode(http, 'http', realHttp);
  wrapNode(https, 'https', realHttps);
}

function restoreRecorder(): void {
  globalThis.fetch = realFetch;
  Object.assign(http, realHttp);
  Object.assign(https, realHttps);
}

function nonLocal(): Outbound[] {
  return recorded.filter((r) => !LOOPBACK.has(r.host));
}

beforeAll(() => {
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && OPT_IN_ENV.test(k)) {
      savedEnv[k] = v;
      delete process.env[k];
    }
  }
});

afterAll(() => {
  Object.assign(process.env, savedEnv);
});

beforeEach(() => {
  recorded = [];
  installRecorder();
});

afterEach(() => {
  restoreRecorder();
});

describe('NN-01 recorder canary', () => {
  test('a non-local fetch and a non-local node:https request are recorded and blocked', async () => {
    await expect(fetch('https://egress-canary.example/v1')).rejects.toThrow('blocked non-local');
    expect(() => https.request('https://egress-canary.example/v2')).toThrow('blocked non-local');
    expect(nonLocal().map((r) => r.via)).toEqual(['fetch', 'node:https.request']);
  });
});

describe('NN-01 no outbound request beyond localhost in local flows', () => {
  let db: Database;
  let stateDir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    closeAll();
    setGlobalStateFile(null);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  test('dashboard: main read routes and admin writes stay on loopback', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'oa-egress-'));
    setGlobalStateFile(join(stateDir, 'agent-access.json'));
    db = createTestDb();
    seedTestData(db);
    await createUser(db, 'admin1', 'password123', 'admin');
    enableAuth(db);
    const token = (await verifyLogin(db, 'admin1', 'password123'))!.token;
    setInitialProfile('test', db);
    const started = await startDashboardServer(db, 0);
    server = started.server;
    const base = `http://localhost:${server.port}`;
    const origin = base;
    const authed = { Authorization: `Bearer ${token}` };
    const writeHeaders = { ...authed, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };

    const reads = [
      '/', // the page itself
      '/api/auth/status',
      '/api/summary', // Overview
      '/api/pnl',
      '/api/alerts',
      '/api/transactions',
      '/api/transactions/search', // no q: a query would load the embedding model
      '/api/reviews',
      '/api/goals',
      '/api/budgets',
      '/api/accounts',
      '/api/net-worth',
      '/api/net-worth/trend',
      '/api/cashflow/monthly', // Forecast inputs
      '/api/savings',
      '/api/interactions',
      '/api/annotations/stats',
      '/api/settings/custom-prompt',
      '/api/config/local-chat',
      '/api/memories',
      '/api/entities',
      '/api/logs',
      '/api/traces',
      '/api/chat/history',
      '/api/export/csv',
    ];
    for (const p of reads) {
      const res = await fetch(`${base}${p}`, { headers: authed });
      expect({ p, status: res.status }).toEqual({ p, status: 200 });
      await res.arrayBuffer();
    }

    const txns = (await (await fetch(`${base}/api/transactions`, { headers: authed })).json()) as unknown;
    const list = (Array.isArray(txns) ? txns : (txns as { transactions: { id: number }[] }).transactions) as { id: number }[];
    expect(list.length).toBeGreaterThan(0);

    const writes: Array<[string, string, unknown]> = [
      ['PATCH', `/api/transactions/${list[0].id}`, { category: 'Groceries' }],
      ['PUT', '/api/budgets/Dining', { monthlyLimit: 150 }],
      ['POST', '/api/memories', { memoryType: 'context', content: 'FAKE memory (dummy)', category: 'test' }],
      ['PUT', '/api/settings/custom-prompt', { prompt: 'FAKE prompt (dummy)' }],
      ['POST', '/api/import', {
        filename: 'fake-egress.csv',
        bank: 'generic',
        transactions: [
          { date: '2026-02-15', description: 'FAKE EGRESS PURCHASE (dummy)', amount: -12.5 },
          { date: '2026-02-16', description: 'FAKE EGRESS REFUND (dummy)', amount: 4.25 },
        ],
      }],
    ];
    for (const [method, p, body] of writes) {
      const res = await fetch(`${base}${p}`, { method, headers: writeHeaders, body: JSON.stringify(body) });
      expect({ method, p, ok: res.status < 400 }).toEqual({ method, p, ok: true });
      await res.arrayBuffer();
    }

    // Everything the test itself sent went to the loopback server, and nothing else went anywhere.
    expect(recorded.length).toBeGreaterThanOrEqual(reads.length + writes.length);
    expect(nonLocal()).toEqual([]);
  }, 30_000);

  test('importers: csv_import tool on a fixture file, plus Chase / OFX / QIF parsers, stay on loopback', async () => {
    db = createTestDb();
    initImportTool(db);
    stateDir = mkdtempSync(join(tmpdir(), 'oa-egress-import-'));
    const file = join(stateDir, 'fake-chase.csv');
    writeFileSync(file, [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,FAKE STORE (dummy),Shopping,Sale,-45.99',
      '02/20/2026,02/21/2026,FAKE PAYMENT (dummy),Payment,Payment,100.00',
    ].join('\n'));
    const out = await csvImportTool.func({ filePath: file });
    expect(String(out)).toContain('2');

    parseChaseCSV('Transaction Date,Post Date,Description,Category,Type,Amount\n02/15/2026,02/16/2026,FAKE (dummy),Other,Sale,-1.00');
    parseOfx('OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260215<TRNAMT>-1.00<FITID>F1<NAME>FAKE (dummy)</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>');
    parseQif('!Type:Bank\nD03/15/2026\nT-1.00\nPFAKE (dummy)\n^');

    expect(nonLocal()).toEqual([]);
  }, 30_000);
});
