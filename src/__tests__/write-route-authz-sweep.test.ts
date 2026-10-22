// @invariant NN-04
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, getUserByUsername, verifyLogin } from '../dashboard/auth.js';
import { setGlobalStateFile } from '../mcp/global-state.js';
import { createChatSession } from '../db/queries.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * NN-04: viewers never write, and every mutating REST route checks the role when auth is on.
 *
 * ROUTES below is the table of EVERY mutating (POST/PUT/PATCH/DELETE) route under /api/ that the dashboard server
 * dispatches to. With auth ON, a viewer and an admin:
 *  - `refuse` rows: the viewer (carrying an allowlisted Origin + `Sec-Fetch-Site: same-origin`, so browser proof is
 *    never what blocks it) is refused (403, or 404 where the route hides what the viewer may not see) and never gets a
 *    2xx; then, as a control, the admin's identical request is NOT refused with 401/403, so the viewer's refusal is
 *    the role check and not a malformed request.
 *  - `self` rows are per-user agent-access state (own grants, own client tokens, own policies). A viewer may manage
 *    their own, but never the privileged variant: each `self` row with a `viewerVariant` sends the write-tool version
 *    and asserts 403.
 *  - `public` and `allowed` rows say WHY a viewer (or nobody) may call them.
 *  - `finding` rows are routes a viewer can mutate today: `test.failing` until fixed (none open; the last, POST
 *    /api/chat/local, was fixed by fix/gf-chat-owner and is now a `self` row).
 * Every non-public row is also sent with no token and must be 401.
 * The static guard at the bottom parses the route modules and fails when a mutating route exists that is not in
 * ROUTES (or ROUTES names one that no longer exists), so a new route cannot skip this sweep.
 */

type Kind =
  | { kind: 'refuse'; status?: number[]; control?: false | { path?: string; body?: unknown } }
  | { kind: 'self'; reason: string; viewerVariant?: { path?: string; body: unknown }; control?: { path?: string; body: unknown } }
  | { kind: 'public'; reason: string; viewerMustNot2xx?: boolean }
  | { kind: 'allowed'; reason: string }
  | { kind: 'finding'; note: string };

type RouteRow = {
  file: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As the static extractor prints it: regex groups -> `:id`, word alternations kept, optional group as `[...]`. */
  pattern: string;
  /** Concrete request path (placeholders filled in at run time: {adminId} {viewerTokenId} {adminTokenId}). */
  path: string;
  body?: unknown;
} & Kind;

const S = 'src/dashboard/server.ts';
const M = 'src/dashboard/mcp-routes.ts';
const J = 'src/dashboard/judgement-routes.ts';
const P = 'src/prelabel/routes.ts';
const WRITE_TOOL = 'categorize_transaction';
const READ_TOOL = 'search_transactions';

const ROUTES: RouteRow[] = [
  // ── auth ──
  { file: S, method: 'POST', pattern: '/api/auth/setup', path: '/api/auth/setup', body: { username: 'evil', password: 'password123' }, kind: 'public', reason: 'First-admin bootstrap: public only while 0 users exist (server.ts:519); with users it must refuse everyone', viewerMustNot2xx: true },
  { file: S, method: 'POST', pattern: '/api/auth/login', path: '/api/auth/login', kind: 'public', reason: 'Login itself; carries no token' },
  { file: S, method: 'POST', pattern: '/api/auth/logout', path: '/api/auth/logout', kind: 'self', reason: 'Ends the caller\'s own session and grants only' },
  { file: S, method: 'POST', pattern: '/api/auth/users', path: '/api/auth/users', body: { username: 'viewer-made', password: 'password123', role: 'admin' }, kind: 'refuse', control: { body: { username: 'admin-made', password: 'password123', role: 'viewer' } } },
  { file: S, method: 'DELETE', pattern: '/api/auth/users/:id', path: '/api/auth/users/{adminId}', kind: 'refuse', control: { path: '/api/auth/users/9999' } },
  { file: S, method: 'PATCH', pattern: '/api/auth/config', path: '/api/auth/config', body: { auth_enabled: false }, kind: 'refuse', control: { body: {} } },
  // ── profiles, budgets, transactions, reviews, goals, entities ──
  { file: S, method: 'POST', pattern: '/api/profiles/switch', path: '/api/profiles/switch', body: { name: 'other' }, kind: 'refuse', control: { body: { name: 'bad name!' } } },
  { file: S, method: 'PUT', pattern: '/api/budgets/:id', path: '/api/budgets/Dining', body: { monthlyLimit: 1 }, kind: 'refuse' },
  { file: S, method: 'PATCH', pattern: '/api/transactions/:id', path: '/api/transactions/1', body: { category: 'Viewer Was Here' }, kind: 'refuse' },
  { file: S, method: 'DELETE', pattern: '/api/transactions/:id', path: '/api/transactions/1', kind: 'refuse', control: { path: '/api/transactions/9999' } },
  { file: S, method: 'POST', pattern: '/api/reviews/:id/(confirm|correct)', path: '/api/reviews/1/confirm', kind: 'refuse' },
  { file: S, method: 'PATCH', pattern: '/api/goals/:id', path: '/api/goals/1', body: { targetAmount: 1 }, kind: 'refuse' },
  { file: S, method: 'POST', pattern: '/api/entities', path: '/api/entities', body: { name: 'FAKE viewer entity (dummy)' }, kind: 'refuse', control: { body: { name: 'FAKE admin entity (dummy)' } } },
  { file: S, method: 'PUT', pattern: '/api/entities/:id', path: '/api/entities/1', body: { name: 'x' }, kind: 'refuse', control: { path: '/api/entities/9999' } },
  { file: S, method: 'DELETE', pattern: '/api/entities/:id', path: '/api/entities/1', kind: 'refuse', control: { path: '/api/entities/9999' } },
  // ── import, memories, settings, models ──
  { file: S, method: 'POST', pattern: '/api/import', path: '/api/import', body: { filename: 'v.csv', bank: 'generic', transactions: [{ date: '2026-02-01', description: 'FAKE viewer import (dummy)', amount: -1 }] }, kind: 'refuse', control: { body: {} } },
  { file: S, method: 'POST', pattern: '/api/demo/trace/step', path: '/api/demo/trace/step', body: { step: 'import' }, kind: 'refuse' },
  { file: S, method: 'POST', pattern: '/api/demo/autobook/candidates', path: '/api/demo/autobook/candidates', kind: 'allowed', reason: 'Read-only lookup (server.ts:904-906); the booking happens only in the WebMCP commit after approval' },
  { file: S, method: 'POST', pattern: '/api/memories', path: '/api/memories', body: { memoryType: 'context', content: 'FAKE viewer memory (dummy)' }, kind: 'refuse', control: { body: { memoryType: 'context', content: 'FAKE admin memory (dummy)' } } },
  { file: S, method: 'DELETE', pattern: '/api/memories/:id', path: '/api/memories/1', kind: 'refuse', control: { path: '/api/memories/9999' } },
  { file: S, method: 'PUT', pattern: '/api/settings/custom-prompt', path: '/api/settings/custom-prompt', body: { prompt: 'viewer prompt' }, kind: 'refuse' },
  { file: S, method: 'POST', pattern: '/api/models', path: '/api/models', body: {}, kind: 'refuse' },
  // ── chat & demos ──
  { file: S, method: 'POST', pattern: '/api/chat', path: '/api/chat', kind: 'allowed', reason: 'A viewer may chat; the run is theirs and every write tool is denied inside it for a non-writer (#156, server.ts:1109-1115)' },
  {
    file: S, method: 'POST', pattern: '/api/chat/local', path: '/api/chat/local', body: { query: 'FAKE viewer question (dummy)', answer: 'FAKE viewer local answer (dummy)' },
    // Fixed by fix/gf-chat-owner: a recorded local answer lands only in the caller's own chat session (auth.ts
    // mayUseChatSession); writing into another user's session (here the admin's) is 403.
    kind: 'self', reason: 'Records into the caller\'s own chat session only (api.ts apiRecordLocalChatMessage)',
    viewerVariant: { body: { query: 'FAKE viewer question (dummy)', answer: 'FAKE forged assistant answer (dummy)', sessionId: '{adminChatSessionId}' } },
    control: { body: { query: 'FAKE admin question (dummy)', answer: 'FAKE admin local answer (dummy)', sessionId: '{adminChatSessionId}' } },
  },
  { file: S, method: 'POST', pattern: '/api/demo/showdown/cloud', path: '/api/demo/showdown/cloud', kind: 'allowed', reason: 'Demo arm: no DB write (sends a fixture sample to the configured cloud model; not sent here)' },
  { file: S, method: 'POST', pattern: '/api/demo/showdown/local', path: '/api/demo/showdown/local', kind: 'allowed', reason: 'Demo arm: no DB write (runs a fixture sample on the local model; not sent here)' },
  { file: S, method: 'POST', pattern: '/api/demo/showdown/browser-trace', path: '/api/demo/showdown/browser-trace', kind: 'allowed', reason: 'Demo recorder: in-memory only, no DB write' },
  { file: S, method: 'POST', pattern: '/api/demo/privacy/start', path: '/api/demo/privacy/start', kind: 'allowed', reason: 'Demo run state is in memory; writes no DB rows (server.ts:1223)' },
  // ── labels and judge queue ──
  { file: S, method: 'POST', pattern: '/api/interactions/:id/annotate', path: '/api/interactions/1/annotate', body: { rating: 5 }, kind: 'refuse' },
  { file: J, method: 'POST', pattern: '/api/judgements/:id/(accept|reject|revoke)', path: '/api/judgements/1/accept', kind: 'refuse' },
  { file: J, method: 'POST', pattern: '/api/judgements/bulk', path: '/api/judgements/bulk', body: { ids: [1], action: 'accept' }, kind: 'refuse' },
  { file: P, method: 'PUT', pattern: '/api/prelabel/settings', path: '/api/prelabel/settings', body: { enabled: true }, kind: 'refuse', control: { body: {} } },
  // ── agent access (WebMCP / MCP) ──
  { file: M, method: 'POST', pattern: '/api/mcp/grants', path: '/api/mcp/grants', kind: 'self', reason: 'Own tab grants; a viewer may grant read tools only (engine.ts grantLocalAccess)', viewerVariant: { body: { tools: [WRITE_TOOL] } }, control: { body: { tools: [WRITE_TOOL] } } },
  { file: M, method: 'DELETE', pattern: '/api/mcp/grants/:id', path: '/api/mcp/grants/x', kind: 'self', reason: 'Revokes the caller\'s own grant: only ever reduces access' },
  { file: M, method: 'POST', pattern: '/api/mcp/grants/revoke-session', path: '/api/mcp/grants/revoke-session', kind: 'self', reason: 'Revokes the caller\'s own grants: only ever reduces access' },
  { file: M, method: 'POST', pattern: '/api/mcp/call', path: '/api/mcp/call', body: { grantId: '00000000-0000-4000-8000-000000000000', tool: WRITE_TOOL, args: { id: 1, category: 'Dining' } }, kind: 'refuse', status: [403, 404], control: false },
  { file: M, method: 'POST', pattern: '/api/mcp/operations/:id/approve', path: '/api/mcp/operations/op-does-not-exist/approve', kind: 'refuse', status: [403, 404], control: false },
  { file: M, method: 'POST', pattern: '/api/mcp/operations/:id/reject', path: '/api/mcp/operations/x/reject', kind: 'allowed', reason: 'A denial never writes (mcp-routes.ts:446-451)' },
  { file: M, method: 'POST', pattern: '/api/mcp/operations/:id/cancel', path: '/api/mcp/operations/x/cancel', kind: 'self', reason: 'Cancels the caller\'s own pending operation (scoped to its session)' },
  { file: M, method: 'POST', pattern: '/api/mcp/client-tokens', path: '/api/mcp/client-tokens', kind: 'self', reason: 'Own /mcp client tokens; a viewer may mint read tools only (client-tokens.ts:127)', viewerVariant: { body: { name: 'viewer-writer', tools: [WRITE_TOOL] } }, control: { body: { name: 'admin-writer', tools: [WRITE_TOOL] } } },
  { file: M, method: 'DELETE', pattern: '/api/mcp/client-tokens/:id[/rotate]', path: '/api/mcp/client-tokens/x', kind: 'self', reason: 'Revokes a token the caller can see (own, or any for an admin)' },
  { file: M, method: 'POST', pattern: '/api/mcp/client-tokens/:id[/rotate]', path: '/api/mcp/client-tokens/x/rotate', kind: 'self', reason: 'Rotates a token the caller can see; the mint rules (role) apply again' },
  { file: M, method: 'PUT', pattern: '/api/mcp/client-tokens/:id/tools', path: '/api/mcp/client-tokens/{viewerTokenId}/tools', kind: 'self', reason: 'Edits a visible token\'s tool list under the mint rules', viewerVariant: { body: { tools: [WRITE_TOOL] } }, control: { path: '/api/mcp/client-tokens/{adminTokenId}/tools', body: { tools: [WRITE_TOOL] } } },
  { file: M, method: 'PUT', pattern: '/api/mcp/settings', path: '/api/mcp/settings', body: { enabled: false }, kind: 'refuse', control: { body: {} } },
  { file: M, method: 'PUT', pattern: '/api/mcp/policies/:id', path: `/api/mcp/policies/${WRITE_TOOL}`, kind: 'self', reason: 'Own per-tool policy; a viewer may only set policies on read tools (policies.ts:17)', viewerVariant: { body: { policy: 'ask' } }, control: { body: { policy: 'ask' } } },
];

/** Route modules the server dispatches /api/ requests to, and dispatchers deliberately outside this sweep. */
const ROUTE_FILES = [S, M, J, P, 'src/dashboard/sync-routes.ts'];
const OUTSIDE_SWEEP: Record<string, string> = {
  '../mcp/http-server.js': '/mcp (not /api/): external MCP clients authenticate every call with a grant-bound client token; covered by mcp-client-tokens.test.ts',
};

// ── Static extraction (kept in step with scripts/verify/run.ts extractMutatingRoutes) ────────────────────────────

const REPO = resolve(import.meta.dir, '..', '..');
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface ExtractedRoute { file: string; method: string; pattern: string; line: number }

/**
 * Regex source of a `path.match(/.../)` -> display pattern: capture groups become `:id`, a word alternation such as
 * `(confirm|correct)` is kept, and an optional group such as `(\/rotate)?` is shown as `[/rotate]`.
 */
function regexToPattern(src: string): string {
  return src
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?!\?)((?:\\.|[^()])*)\)(\?)?/g, (_m, inner: string, opt?: string) => {
      const body = inner.replace(/\\\//g, '/');
      if (opt) return `[${body}]`;
      return /^[\w|]+$/.test(body) && body.includes('|') ? `(${body})` : ':id';
    })
    .replace(/\\\//g, '/');
}

function extractMutatingRoutes(file: string, text: string): ExtractedRoute[] {
  const lines = text.split('\n');
  const matchVars = new Map<string, string>();
  const literalVars = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/const (\w+) = path\.match\(\/(.+)\/\);/);
    if (m) matchVars.set(m[1], m[2]);
    const lit = l.match(/const (\w+) = path === '([^']+)';/);
    if (lit) literalVars.set(lit[1], lit[2]);
  }
  const out: ExtractedRoute[] = [];
  lines.forEach((line, i) => {
    const methods = [...line.matchAll(/req\.method\s*(===|!==)\s*'(\w+)'/g)].filter((m) => (MUTATING as readonly string[]).includes(m[2]));
    if (methods.length === 0) return;
    const patterns: string[] = [];
    for (const lit of line.matchAll(/path === '(\/api\/[^']+)'/g)) patterns.push(lit[1]);
    for (const [name, src] of matchVars) if (new RegExp(`\\b${name}\\b`).test(line)) patterns.push(regexToPattern(src));
    for (const [name, lit] of literalVars) if (new RegExp(`\\b${name}\\b`).test(line)) patterns.push(lit);
    if (patterns.length === 0) {
      const prev = lines.slice(0, i).reverse().find((l) => l.trim() !== '') ?? '';
      const comment = prev.match(/\/\/\s*(POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/);
      if (comment) patterns.push(comment[2]);
    }
    if (patterns.length === 0) {
      for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
        const enclosing = lines[j].match(/^\s*if \((\w+)\) \{/);
        if (enclosing && matchVars.has(enclosing[1])) {
          patterns.push(regexToPattern(matchVars.get(enclosing[1])!));
          break;
        }
        const enclosingLit = lines[j].match(/^\s*if \(path === '(\/api\/[^']+)'\) \{/);
        if (enclosingLit) {
          patterns.push(enclosingLit[1]);
          break;
        }
      }
    }
    if (patterns.length === 0) patterns.push('<unresolved>');
    for (const m of methods) for (const p of patterns) if (p.startsWith('/api/') || p === '<unresolved>') out.push({ file, method: m[2], pattern: p, line: i + 1 });
  });
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.method} ${r.pattern}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Live sweep ──────────────────────────────────────────────────────────────────────────────────────────────────

let db: Database;
let stateDir: string;
let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
let base = '';
let origin = '';
let adminToken = '';
let viewerToken = '';
const vars: Record<string, string> = {};

const fill = (p: string) => p.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `missing-${k}`);

async function send(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
    'X-Wilson-Agent-Session': crypto.randomUUID(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${fill(path)}`, { method, headers, body: method === 'DELETE' && body === undefined ? undefined : fill(JSON.stringify(body ?? {})) });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'oa-authz-sweep-'));
  setGlobalStateFile(join(stateDir, 'agent-access.json'));
  db = createTestDb();
  seedTestData(db);
  await createUser(db, 'admin1', 'password123', 'admin');
  await createUser(db, 'viewer1', 'password123', 'viewer');
  enableAuth(db);
  adminToken = (await verifyLogin(db, 'admin1', 'password123'))!.token;
  viewerToken = (await verifyLogin(db, 'viewer1', 'password123'))!.token;
  vars.adminId = String(getUserByUsername(db, 'admin1')!.id);
  vars.adminChatSessionId = createChatSession(db, getUserByUsername(db, 'admin1')!.id);
  setInitialProfile('test', db);
  server = (await startDashboardServer(db, 0)).server;
  base = `http://localhost:${server.port}`;
  origin = base;
  // A read-only client token for each, so the token tools route has a token the caller can see.
  const mint = async (token: string, name: string) => {
    const r = await send('POST', '/api/mcp/client-tokens', token, { name, tools: [READ_TOOL] });
    expect(r.status).toBe(200);
    return (JSON.parse(r.text) as { meta: { id: string } }).meta.id;
  };
  vars.viewerTokenId = await mint(viewerToken, 'viewer-reader');
  vars.adminTokenId = await mint(adminToken, 'admin-reader');
});

afterAll(() => {
  try { stopDashboardServer(server); } catch { /* */ }
  closeAll();
  setGlobalStateFile(null);
  rmSync(stateDir, { recursive: true, force: true });
});

const label = (r: RouteRow) => `${r.method} ${r.pattern}`;

describe('NN-04 viewer cannot mutate (auth on, browser proof present)', () => {
  for (const r of ROUTES) {
    if (r.kind === 'refuse') {
      test(`viewer refused: ${label(r)}`, async () => {
        const res = await send(r.method, r.path, viewerToken, r.body);
        const allowed = r.status ?? [403];
        if (!allowed.includes(res.status)) console.error(`[sweep] ${label(r)} -> ${res.status} ${res.text.slice(0, 300)}`);
        expect({ route: label(r), status: res.status, refused: allowed.includes(res.status) }).toEqual({ route: label(r), status: res.status, refused: true });
        expect(res.status >= 200 && res.status < 300).toBe(false);
      });
    } else if (r.kind === 'self' && r.viewerVariant) {
      const v = r.viewerVariant;
      test(`viewer refused the write-tool variant: ${label(r)}`, async () => {
        const res = await send(r.method, v.path ?? r.path, viewerToken, v.body);
        expect({ route: label(r), status: res.status, ok: res.status < 300 }).toEqual({ route: label(r), status: 403, ok: false });
      });
    } else if (r.kind === 'public' && r.viewerMustNot2xx) {
      test(`public route still refuses once users exist: ${label(r)}`, async () => {
        const res = await send(r.method, r.path, viewerToken, r.body);
        expect(res.status >= 200 && res.status < 300).toBe(false);
      });
    } else if (r.kind === 'finding') {
      test.failing(`FINDING viewer can mutate: ${label(r)} (${r.note})`, async () => {
        const res = await send(r.method, r.path, viewerToken, r.body);
        expect(res.status).toBe(403);
      });
    }
  }
});

describe('NN-04 no token: every non-public mutating route is 401', () => {
  for (const r of ROUTES) {
    if (r.kind === 'public') continue;
    test(`no token: ${label(r)}`, async () => {
      const res = await send(r.method, r.path, null, r.body);
      expect({ route: label(r), status: res.status }).toEqual({ route: label(r), status: 401 });
    });
  }
});

describe('NN-04 controls: the admin is not refused, so the viewer refusals above are the role check', () => {
  for (const r of ROUTES) {
    const control = r.kind === 'refuse' ? (r.control === false ? null : r.control ?? {}) : r.kind === 'self' ? r.control ?? null : null;
    if (!control) continue;
    test(`admin control: ${label(r)}`, async () => {
      const body = 'body' in control ? control.body : r.body;
      const res = await send(r.method, control.path ?? r.path, adminToken, body);
      expect({ route: label(r), refused: res.status === 401 || res.status === 403, body: res.status === 401 || res.status === 403 ? res.text : '' })
        .toEqual({ route: label(r), refused: false, body: '' });
    });
  }
});

describe('NN-04 static guard: the table covers every mutating route in the source', () => {
  test('every POST/PUT/PATCH/DELETE route under /api/ in the route modules is in ROUTES, and vice versa', () => {
    const found = ROUTE_FILES.flatMap((f) => extractMutatingRoutes(f, readFileSync(join(REPO, f), 'utf8')));
    expect(found.filter((r) => r.pattern === '<unresolved>')).toEqual([]);
    const inSource = new Set(found.map((r) => `${r.file} ${r.method} ${r.pattern}`));
    const inTable = new Set(ROUTES.map((r) => `${r.file} ${r.method} ${r.pattern}`));
    const missingFromTable = [...inSource].filter((k) => !inTable.has(k));
    const staleInTable = [...inTable].filter((k) => !inSource.has(k));
    expect({ missingFromTable, staleInTable }).toEqual({ missingFromTable: [], staleInTable: [] });
  });

  test('every route module server.ts dispatches to is swept or explicitly outside the sweep', () => {
    const server = readFileSync(join(REPO, S), 'utf8');
    const modules = [...server.matchAll(/import \{[^}]*\bhandle\w+(?:Route|Request)\b[^}]*\} from '([^']+)'/g)].map((m) => m[1]);
    expect(modules.length).toBeGreaterThan(0);
    const swept = new Set(ROUTE_FILES.map((f) => f.replace(/^src\//, '')));
    const unaccounted = modules.filter((m) => {
      if (OUTSIDE_SWEEP[m]) return false;
      const rel = join('dashboard', m).replace(/\.js$/, '.ts');
      return !swept.has(rel);
    });
    expect(unaccounted).toEqual([]);
  });
});
