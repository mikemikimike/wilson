#!/usr/bin/env bun
/**
 * `bun run verify`: the MUST NOT TRADE OFF gate plus a coverage map.
 *
 *  1. Parses the MUST NOT TRADE OFF table in CLAUDE.md (ID, rule, Check) and resolves each check to test files
 *     (`foo.test.ts`, `foo*.test.ts`, or shorthand `foo` / `foo*` -> src/__tests__/foo*.test.ts). Tests can also
 *     declare what they prove with a tag comment, `// @invariant NN-04` or `// @invariant TM-8.3`; tags are read
 *     first, the table second. NN-09 (review-only) and NN-10 (e2e) are "external": shown, never failing the gate.
 *  2. Adds the nine security invariants of specs/webmcp-threat-model.md §8 as TM-8.n rows, backed by tagged tests
 *     first, else by known test files that contain the invariant's key terms.
 *  3. Runs every referenced test file in its own `bun test` process (like CI), a few at a time.
 *  4. Prints a coverage map: mutating dashboard routes, UI tabs vs e2e/critical-paths.mjs, agent tools, WebMCP tools.
 *
 * Writes .verify/verify-report.json and .verify/verify-report.md. Exits 1 when any NN rule has a failing or missing
 * test; coverage gaps are reported but never fail. Dependency-free (Bun + node builtins).
 *
 * Flags: --concurrency N (default 4, or VERIFY_CONCURRENCY), --no-run (resolve and map only, no tests run).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const TESTS_DIR = join(ROOT, 'src', '__tests__');
const OUT_DIR = join(ROOT, '.verify');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CONCURRENCY = Math.max(1, Number(opt('--concurrency') ?? process.env.VERIFY_CONCURRENCY ?? 4) || 4);
const NO_RUN = flag('--no-run');
const PER_FILE_TIMEOUT_MS = 300_000;

const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(ROOT, p);
const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts')).sort();
const testText = new Map(testFiles.map((f) => [f, read(join(TESTS_DIR, f))]));

// ── Tags ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** invariant id -> test files that declare it with `// @invariant <ids>`. */
const tags = new Map<string, string[]>();
for (const [f, text] of testText) {
  for (const m of text.matchAll(/^\s*\/\/\s*@invariant\s+(.+)$/gm)) {
    for (const id of m[1].split(/[\s,]+/).filter((s) => /^(NN-\d+|TM-8\.\d+)$/.test(s))) {
      tags.set(id, [...(tags.get(id) ?? []), f]);
    }
  }
}

// ── NN rules from CLAUDE.md ───────────────────────────────────────────────────────────────────────────────────

type Status = 'pass' | 'fail' | 'missing' | 'external';
interface RuleRow {
  id: string;
  title: string;
  check: string;
  /** Test files (basename in src/__tests__) that back this row. */
  tests: string[];
  /** How each test was found: tag or table. */
  via: Record<string, 'tag' | 'table' | 'terms'>;
  /** Check tokens that are not tests but name a real file (preload, guard script). */
  support: string[];
  /** Check tokens that resolved to nothing. */
  unresolved: string[];
  external?: string;
  status?: Status;
  detail?: string;
}

function globToRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

function resolveCheckToken(token: string): { tests: string[]; support?: string; unresolved?: boolean; external?: string } {
  const t = token.trim();
  if (/^bun run e2e$/.test(t)) return { tests: [], external: 'e2e' };
  if (t.startsWith('/')) return { tests: [], external: 'review' };
  if (t.includes('/') || (t.endsWith('.ts') && !t.endsWith('.test.ts'))) {
    const candidates = [join(ROOT, t), join(TESTS_DIR, t)];
    const hit = candidates.find((c) => existsSync(c));
    return hit ? { tests: [], support: rel(hit) } : { tests: [], unresolved: true };
  }
  const glob = t.endsWith('.test.ts') ? t : `${t.replace(/\*?$/, '')}*.test.ts`;
  const re = globToRegex(glob);
  const tests = testFiles.filter((f) => re.test(f));
  return tests.length ? { tests } : { tests: [], unresolved: true };
}

function parseClaudeTable(): RuleRow[] {
  const md = read(join(ROOT, 'CLAUDE.md'));
  const section = md.slice(md.indexOf('## MUST NOT TRADE OFF'));
  const rows: RuleRow[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*(NN-\d+)\s*\|(.*)\|(.*)\|\s*$/);
    if (!m) continue;
    const [, id, ruleCell, checkCell] = m;
    const title = (ruleCell.match(/\*\*(.+?)\*\*/)?.[1] ?? ruleCell).trim().replace(/\.$/, '');
    const row: RuleRow = { id, title, check: checkCell.trim(), tests: [], via: {}, support: [], unresolved: [] };
    for (const f of tags.get(id) ?? []) {
      row.tests.push(f);
      row.via[f] = 'tag';
    }
    const tokens = [...checkCell.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    for (const tok of tokens) {
      const r = resolveCheckToken(tok);
      if (r.external) row.external = r.external;
      if (r.support) row.support.push(r.support);
      if (r.unresolved) row.unresolved.push(tok);
      for (const f of r.tests) {
        if (!row.via[f]) {
          row.tests.push(f);
          row.via[f] = 'table';
        }
      }
    }
    if (/Reviewed by|not script-checkable/i.test(checkCell)) row.external = 'review';
    rows.push(row);
  }
  return rows;
}

// ── Threat model §8 invariants ──────────────────────────────────────────────────────────────────────────────────

/** Where to look for each §8 invariant when no test is tagged: candidate test files and the terms they must contain. */
const TM_HINTS: Record<number, { files: string[]; terms: RegExp }> = {
  1: { files: ['mcp-page-tools', 'mcp-declarative', 'demo-auto-book-ui'], terms: /ungranted|no grant|zero tools/i },
  2: { files: ['approval-surfaces', 'mcp-adapter-mutation', 'mcp-declarative'], terms: /approv/i },
  3: { files: ['mcp-approval', 'mcp-hardening'], terms: /callTool|transport/ },
  4: { files: ['judge-tools', 'mcp-judge-queue', 'annotations-versioning'], terms: /proposed/ },
  5: { files: ['training-export'], terms: /includeJudge|agent_present|agentPresent/ },
  6: { files: ['mcp-webmcp-session-not-bearer', 'mcp-client-tokens', 'mcp-audit-log'], terms: /session_generation|sessionGeneration|token/ },
  7: { files: ['dashboard-origin-gate', 'prelabel-origin-gate'], terms: /Access-Control-Allow-Origin/ },
  8: { files: ['mcp-approval-hardening', 'chat-role-demotion', 'chat-deactivation'], terms: /expire|demot|deactivat/i },
  9: { files: ['mcp-kill-switch'], terms: /kill switch|killSwitch/i },
};

function parseThreatModel(): RuleRow[] {
  const spec = read(join(ROOT, 'specs', 'webmcp-threat-model.md'));
  const start = spec.search(/^## 8\. /m);
  if (start < 0) return [];
  const body = spec.slice(start).split(/\n## /)[0];
  const rows: RuleRow[] = [];
  for (const m of body.matchAll(/^(\d+)\.\s+(.+)$/gm)) {
    const n = Number(m[1]);
    const id = `TM-8.${n}`;
    const title = m[2].replace(/\*\*/g, '').split(/(?<=\.)\s/)[0].replace(/\.$/, '');
    const row: RuleRow = { id, title, check: 'tags, then key terms', tests: [], via: {}, support: [], unresolved: [] };
    for (const f of tags.get(id) ?? []) {
      row.tests.push(f);
      row.via[f] = 'tag';
    }
    const hint = TM_HINTS[n];
    if (hint) {
      for (const h of hint.files) {
        const f = `${h}.test.ts`;
        if (!row.via[f] && hint.terms.test(testText.get(f) ?? '')) {
          row.tests.push(f);
          row.via[f] = 'terms';
        }
      }
    }
    if (row.tests.length === 0) row.unresolved.push(hint ? 'no tagged test and no hinted file contains the key terms' : 'no hint configured');
    rows.push(row);
  }
  return rows;
}

// ── Running tests ──────────────────────────────────────────────────────────────────────────────────────────────

interface TestRun { file: string; ok: boolean; code: number | null; ms: number; pass: number; fail: number; tail: string }

async function runOne(file: string): Promise<TestRun> {
  const t0 = performance.now();
  const child = Bun.spawn(['bun', 'test', `src/__tests__/${file}`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const timer = setTimeout(() => child.kill(), PER_FILE_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(timer);
  const all = `${out}\n${err}`;
  const num = (re: RegExp) => Number(all.match(re)?.[1] ?? 0);
  return {
    file,
    ok: child.exitCode === 0,
    code: child.exitCode,
    ms: Math.round(performance.now() - t0),
    pass: num(/^\s*(\d+) pass$/m),
    fail: num(/^\s*(\d+) fail$/m),
    tail: all.split('\n').filter((l) => l.startsWith('(fail)') || l.includes('error:')).slice(0, 8).join('\n'),
  };
}

async function runAll(files: string[]): Promise<Map<string, TestRun>> {
  const results = new Map<string, TestRun>();
  const queue = [...files];
  let done = 0;
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await runOne(f);
      results.set(f, r);
      done += 1;
      process.stderr.write(`  [${String(done).padStart(2)}/${files.length}] ${r.ok ? 'ok  ' : 'FAIL'} ${f} (${(r.ms / 1000).toFixed(1)}s)\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return results;
}

// ── Coverage map ────────────────────────────────────────────────────────────────────────────────────────────────

/** Files whose text counts as "a test references it". */
const e2eFile = join(ROOT, 'e2e', 'critical-paths.mjs');
// The suite keeps its path table in e2e/paths.mjs; scan every top-level e2e module.
const e2eText = existsSync(e2eFile)
  ? readdirSync(join(ROOT, 'e2e')).filter((f) => f.endsWith('.mjs')).map((f) => read(join(ROOT, 'e2e', f))).join('\n')
  : null;
/** Last suite run, if any: e2e/results/latest.json (written by `bun run e2e`). */
const e2eLatest = (() => {
  const f = join(ROOT, 'e2e', 'results', 'latest.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(read(f)) as { summary?: { passed?: number; failed?: number; skipped?: number; nn10?: Record<string, { pass?: boolean; value?: unknown }> }; paths?: Array<{ id: string; status?: string; result?: string }>; coverage?: { tabs?: Record<string, string[]> }; meta?: { finishedAt?: string; startedAt?: string } }; } catch { return null; }
})();
const allTestText = [...testText.values()].join('\n');

/** Mutating routes, same extraction as src/__tests__/write-route-authz-sweep.test.ts (keep the two in step). */
const ROUTE_FILES = ['src/dashboard/server.ts', 'src/dashboard/mcp-routes.ts', 'src/dashboard/judgement-routes.ts', 'src/prelabel/routes.ts', 'src/dashboard/sync-routes.ts'];

function regexToPattern(src: string): string {
  return src
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?!\?)((?:\\.|[^()])*)\)(\?)?/g, (_m, inner: string, optional?: string) => {
      const body = inner.replace(/\\\//g, '/');
      if (optional) return `[${body}]`;
      return /^[\w|]+$/.test(body) && body.includes('|') ? `(${body})` : ':id';
    })
    .replace(/\\\//g, '/');
}

interface Route { file: string; method: string; pattern: string; line: number }

function extractMutatingRoutes(file: string, text: string): Route[] {
  const lines = text.split('\n');
  const matchVars = new Map<string, string>();
  const literalVars = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/const (\w+) = path\.match\(\/(.+)\/\);/);
    if (m) matchVars.set(m[1], m[2]);
    const lit = l.match(/const (\w+) = path === '([^']+)';/);
    if (lit) literalVars.set(lit[1], lit[2]);
  }
  const out: Route[] = [];
  lines.forEach((line, i) => {
    const methods = [...line.matchAll(/req\.method\s*(===|!==)\s*'(\w+)'/g)].filter((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m[2]));
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

/** A route pattern -> regex over test source: `:id` matches a literal segment or a `${...}` interpolation. */
function routeRegex(pattern: string): RegExp {
  let src = '';
  for (const part of pattern.split(/(:id|\[[^\]]+\]|\([\w|]+\))/)) {
    if (part === ':id') src += '(?:\\$\\{[^}]+\\}|[^/\'"`\\s?]+)';
    else if (/^\[.+\]$/.test(part)) src += `(?:${part.slice(1, -1).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')})?`;
    else if (/^\([\w|]+\)$/.test(part)) src += `(?:${part.slice(1, -1)}|\\$\\{[^}]+\\})`;
    else src += part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`${src}(?=['"\`?\\s]|$)`, 'm');
}

interface CoverageItem { name: string; covered: boolean; where?: string; /** Referenced only by an authz-only test: shown ⚠️, not counted. */ partial?: boolean }
interface CoverageSection { title: string; short: string; items: CoverageItem[]; note?: string }

/** Tests that touch every route for authz/egress only; a route they alone reference has no functional test. */
const SWEEP_ONLY = new Set(['write-route-authz-sweep.test.ts']);

function routeCoverage(): CoverageSection {
  const items: CoverageItem[] = [];
  for (const f of ROUTE_FILES) {
    for (const r of extractMutatingRoutes(f, read(join(ROOT, f)))) {
      const re = routeRegex(r.pattern);
      const where = [...testText].filter(([, t]) => re.test(t)).map(([n]) => n);
      const functional = where.filter((n) => !SWEEP_ONLY.has(n));
      items.push({
        name: `${r.method} ${r.pattern}  (${f}:${r.line})`,
        covered: functional.length > 0,
        partial: functional.length === 0 && where.length > 0,
        where: (functional.length ? functional : where).slice(0, 3).join(', '),
      });
    }
  }
  return { title: 'Mutating dashboard routes referenced by a test (beyond the authz sweep)', short: 'routes', items };
}

function tabCoverage(): CoverageSection {
  const tabBar = read(join(ROOT, 'src', 'dashboard', 'ui', 'src', 'components', 'TabBar.tsx'));
  let source = tabBar;
  if (!/const TAB_IDS\s*=/.test(tabBar) && /TAB_IDS[^;]*from '@webmcp-session'/.test(tabBar)) source = read(join(ROOT, 'src', 'dashboard', 'webmcp-session.ts'));
  const list = source.match(/TAB_IDS\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
  const ids = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ran = e2eLatest?.coverage?.tabs;
  const status = new Map((e2eLatest?.paths ?? []).map((p) => [p.id, p.status ?? p.result]));
  const items = ids.map((id) => {
    // Prefer the last run: a tab is covered when a path that visited it passed.
    if (ran) {
      const passed = (ran[id] ?? []).filter((p) => /^pass/.test(String(status.get(p) ?? 'pass')));
      return { name: id, covered: passed.length > 0, where: passed.length ? `last e2e run: ${passed.join(', ')}` : undefined };
    }
    const re = new RegExp(`(?:tab|covers)\\s*:\\s*(?:\\[[^\\]]*)?['"\`]${id}['"\`]`);
    const covered = e2eText !== null && re.test(e2eText);
    return { name: id, covered, where: covered ? 'e2e (not run yet)' : undefined };
  });
  return { title: 'Dashboard UI tabs covered by e2e/critical-paths.mjs', short: 'tabs (e2e)', items, note: e2eText === null ? 'e2e/critical-paths.mjs not found: every tab counts as uncovered' : undefined };
}

function agentToolCoverage(): CoverageSection {
  const reg = read(join(ROOT, 'src', 'tools', 'registry.ts'));
  const body = reg.slice(reg.indexOf('export async function getToolRegistry'));
  const lines = body.split('\n');
  const items: CoverageItem[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const m = l.match(/name: '(\w+)'/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    const ident = lines.slice(i, i + 4).join(' ').match(/tool: (?:\w+\.)?(\w+)/)?.[1];
    const nameRe = new RegExp(`['"\`]${m[1]}['"\`]`);
    const where = [...testText].filter(([, t]) => nameRe.test(t) || (ident ? new RegExp(`\\b${ident}\\b`).test(t) : false)).map(([n]) => n);
    items.push({ name: m[1], covered: where.length > 0, where: where.slice(0, 3).join(', ') });
  });
  return { title: 'Agent tools (src/tools/registry.ts) referenced by a test', short: 'agent tools', items };
}

function webMcpCoverage(): CoverageSection {
  const cat = read(join(ROOT, 'src', 'mcp', 'tool-catalog.ts'));
  const start = cat.indexOf('export const MCP_TOOL_CATALOG');
  const block = cat.slice(start, cat.indexOf('\n];', start));
  const names = [...block.matchAll(/^ {4}name: '(\w+)'/gm)].map((m) => m[1]);
  const items = names.map((n) => {
    const re = new RegExp(`['"\`]${n}['"\`]`);
    const where = [...testText].filter(([, t]) => re.test(t)).map(([f]) => f);
    const inE2e = e2eText !== null && re.test(e2eText);
    return { name: n, covered: where.length > 0 || inE2e, where: [inE2e ? 'e2e' : '', ...where.slice(0, 2)].filter(Boolean).join(', ') };
  });
  return { title: 'WebMCP tools the dashboard registers (MCP_TOOL_CATALOG, served to the page bridge) referenced by e2e or a test', short: 'webmcp tools', items };
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────────

function nn10Status(): string {
  if (!e2eLatest) return 'not run (no readable e2e/results/latest.json)';
  const s = e2eLatest.summary ?? {};
  const targets = Object.entries(s.nn10 ?? {}).map(([k, v]) => `${k} ${v.pass ? 'pass' : `FAIL (${JSON.stringify(v.value)})`}`);
  const when = e2eLatest.meta?.finishedAt ?? e2eLatest.meta?.startedAt;
  return `paths ${s.passed ?? '?'} pass / ${s.failed ?? '?'} fail / ${s.skipped ?? '?'} skipped; ${targets.join('; ') || 'no NN-10 targets recorded'}${when ? ` (${when})` : ''}`;
}

const icon = (s: Status | undefined) => (s === 'pass' ? '✅' : s === 'external' ? '⚠️ ' : '❌');
const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

async function main(): Promise<number> {
  const nn = parseClaudeTable();
  const tm = parseThreatModel();
  if (nn.length === 0) {
    console.error('verify: could not parse the MUST NOT TRADE OFF table in CLAUDE.md');
    return 1;
  }
  const files = [...new Set([...nn, ...tm].flatMap((r) => r.tests))].sort();
  process.stderr.write(`verify: ${nn.length} NN rules, ${tm.length} threat-model invariants, ${files.length} test files (concurrency ${CONCURRENCY})\n`);
  const t0 = performance.now();
  const runs = NO_RUN ? new Map<string, TestRun>() : await runAll(files);

  for (const r of [...nn, ...tm]) {
    if (r.tests.length === 0 && r.external) {
      r.status = 'external';
      r.detail = r.external === 'e2e' ? nn10Status() : 'review (/security-gate)';
      continue;
    }
    if (r.tests.length === 0) {
      r.status = 'missing';
      r.detail = r.unresolved.length ? `unresolved: ${r.unresolved.join(', ')}` : 'no test';
      continue;
    }
    if (NO_RUN) {
      r.status = r.unresolved.length ? 'missing' : 'pass';
      r.detail = 'not run (--no-run)';
      continue;
    }
    const failed = r.tests.filter((f) => !runs.get(f)?.ok);
    r.status = failed.length ? 'fail' : r.unresolved.length ? 'missing' : 'pass';
    r.detail = failed.length ? `failing: ${failed.join(', ')}` : r.unresolved.length ? `unresolved: ${r.unresolved.join(', ')}` : '';
  }

  const coverage = [routeCoverage(), tabCoverage(), agentToolCoverage(), webMcpCoverage()];
  const totalMs = Math.round(performance.now() - t0);

  // ── Terminal ──
  const out: string[] = [];
  const w = (s = '') => out.push(s);
  w('');
  w('MUST NOT TRADE OFF (CLAUDE.md)');
  for (const r of nn) {
    const ts = r.tests.map((f) => `${f.replace(/\.test\.ts$/, '')}${r.via[f] === 'tag' ? '#' : ''}${runs.get(f) ? ` ${(runs.get(f)!.ms / 1000).toFixed(1)}s` : ''}`).join(', ');
    w(`  ${icon(r.status)} ${r.id.padEnd(7)} ${r.title.slice(0, 64).padEnd(64)} ${r.status === 'external' ? r.detail : ts}${r.detail && r.status !== 'external' ? `  [${r.detail}]` : ''}`);
  }
  w('');
  w('Threat model §8 security invariants (specs/webmcp-threat-model.md)');
  for (const r of tm) {
    const ts = r.tests.map((f) => `${f.replace(/\.test\.ts$/, '')}${r.via[f] === 'tag' ? '#' : r.via[f] === 'terms' ? '~' : ''}`).join(', ');
    w(`  ${icon(r.status)} ${r.id.padEnd(7)} ${r.title.slice(0, 64).padEnd(64)} ${ts}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  w('  (# = found by @invariant tag, ~ = found by key terms)');
  for (const s of coverage) {
    const c = s.items.filter((i) => i.covered).length;
    w('');
    w(`${s.title}: ${c}/${s.items.length} (${pct(c, s.items.length)})${s.note ? `  — ${s.note}` : ''}`);
    for (const i of s.items) w(`  ${i.covered ? '✅' : i.partial ? '⚠️ ' : '❌'} ${i.name}${i.where ? `  ← ${i.where}` : ''}${i.partial ? ' (authz only)' : ''}`);
  }
  const nnFail = nn.filter((r) => r.status === 'fail' || r.status === 'missing');
  const tmFail = tm.filter((r) => r.status === 'fail' || r.status === 'missing');
  const cov = coverage.map((s) => {
    const c = s.items.filter((i) => i.covered).length;
    const partial = s.items.filter((i) => i.partial).length;
    return `${s.short} covered ${c}/${s.items.length} (${pct(c, s.items.length)})${partial ? ` +${partial} authz-only` : ''}`;
  });
  w('');
  w('Summary');
  w(`  NN rules: ${nn.filter((r) => r.status === 'pass').length} pass, ${nnFail.length} fail/missing, ${nn.filter((r) => r.status === 'external').length} external`);
  w(`  TM-8 invariants: ${tm.filter((r) => r.status === 'pass').length}/${tm.length} backed${NO_RUN ? ' (tests not run)' : ' and passing'}${tmFail.length ? ` (${tmFail.map((r) => r.id).join(', ')} not)` : ''}`);
  w(`  Test files run: ${runs.size} in ${(totalMs / 1000).toFixed(1)}s, ${[...runs.values()].filter((r) => !r.ok).length} failing`);
  w(`  Coverage: ${cov.join('; ')}`);
  w(`  Gate: ${nnFail.length ? `FAIL (${nnFail.map((r) => r.id).join(', ')})` : 'PASS'}${NO_RUN ? ' (dry run: --no-run, nothing executed)' : ''}`);
  console.log(out.join('\n'));
  for (const r of runs.values()) if (!r.ok && r.tail) console.log(`\n--- ${r.file} (exit ${r.code})\n${r.tail}`);

  // ── Reports ──
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    gate: nnFail.length ? 'fail' : 'pass',
    nn,
    threatModel: tm,
    testRuns: [...runs.values()],
    coverage: coverage.map((s) => ({ ...s, covered: s.items.filter((i) => i.covered).length, total: s.items.length })),
  };
  writeFileSync(join(OUT_DIR, 'verify-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const md: string[] = [`# verify report`, '', `Generated ${report.generatedAt}. Gate: **${report.gate.toUpperCase()}**.`, ''];
  const table = (title: string, rows: RuleRow[]) => {
    md.push(`## ${title}`, '', '| | ID | Rule | Tests | Note |', '|---|---|---|---|---|');
    for (const r of rows) md.push(`| ${icon(r.status).trim()} | ${r.id} | ${r.title.replace(/\|/g, '\\|')} | ${r.tests.map((f) => `\`${f}\`${r.via[f] === 'tag' ? ' (tag)' : r.via[f] === 'terms' ? ' (terms)' : ''}`).join('<br>')} | ${(r.detail ?? '').replace(/\|/g, '\\|')} |`);
    md.push('');
  };
  table('MUST NOT TRADE OFF', nn);
  table('Threat model §8', tm);
  for (const s of coverage) {
    const c = s.items.filter((i) => i.covered).length;
    md.push(`## ${s.title}: ${c}/${s.items.length} (${pct(c, s.items.length)})`, '');
    if (s.note) md.push(`_${s.note}_`, '');
    for (const i of s.items) md.push(`- ${i.covered ? '✅' : i.partial ? '⚠️' : '❌'} \`${i.name}\`${i.where ? ` — ${i.where}` : ''}${i.partial ? ' (authz only)' : ''}`);
    md.push('');
  }
  writeFileSync(join(OUT_DIR, 'verify-report.md'), `${md.join('\n')}\n`);
  console.log(`\nReports: ${rel(join(OUT_DIR, 'verify-report.json'))}, ${rel(join(OUT_DIR, 'verify-report.md'))}`);
  return nnFail.length ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main());
}
