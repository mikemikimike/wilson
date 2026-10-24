#!/usr/bin/env node
// Wilson critical-path browser suite, driven by agent-browser (pinned in e2e/package.json).
//
//   bun run e2e            (= node e2e/critical-paths.mjs)
//
// Starts its own throwaway sandbox (bun run sandbox:up --auth --name e2e), runs every path in e2e/paths.mjs, samples
// page performance, writes e2e/results/latest.json (+ per-path videos), and always tears the sandbox down.
// Env: see e2e/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { AgentBrowser, E2E_DIR, AGENT_BROWSER_VERSION } from './lib/ab.mjs';
import { LAYOUT_AUDIT_JS, OVERFLOW_JS, VITALS_JS, sleep, waitFor } from './lib/page.mjs';
import { MOBILE4G, percentile, sandboxDown, sandboxFile, sandboxUp, serverLogErrors, summarize, throttlePage } from './lib/support.mjs';
import { PATHS } from './paths.mjs';

const REPO = path.resolve(E2E_DIR, '..');
const RESULTS = path.join(E2E_DIR, 'results');
const VIDEO_DIR = path.join(RESULTS, 'video');
const SANDBOX = process.env.E2E_SANDBOX_NAME || 'e2e';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const SAMPLES = Math.max(1, Number(env('E2E_SAMPLES', 3)));
const RECORD = env('E2E_RECORD', '1') !== '0';
const PERF = env('E2E_PERF', '1') !== '0';
const THROTTLE = env('E2E_THROTTLE', '1') !== '0';
const HEADED = env('E2E_HEADED', '0') === '1';
const ONLY = env('E2E_ONLY', '') ? env('E2E_ONLY', '').split(',').map((s) => s.trim().toUpperCase()) : null;
const KEEP = env('E2E_KEEP', '0') === '1';

const TAB_READY = {
  overview: 'this week',
  transactions: 'transactions',
  review: 'pending',
  accounts: 'net worth',
  goals: 'active goals',
  forecast: 'median net worth in',
  chat: 'new chat',
  llm: 'total calls',
  logs: 'debug',
  settings: 'agent access',
};
const TABS = Object.keys(TAB_READY);

// NN-10 targets (CLAUDE.md MUST NOT TRADE OFF).
const TARGETS = { mutationP95Ms: 300, lcpP75MsMobile4g: 2000, clsP75: 0.1, noHorizontalScrollAt360: true };

class SkipError extends Error {}

const log = (...a) => console.log(...a);
const now = () => new Date().toISOString();

// ── lifecycle ────────────────────────────────────────────────────────────────

let ab = null;
let sb = null;
let tornDown = false;
let recording = false;

async function teardown(reason) {
  if (tornDown) return;
  tornDown = true;
  try { if (ab && recording) await ab.run(['record', 'stop'], { timeout: 30_000 }); } catch { /* */ }
  try { if (ab) await ab.run(['close'], { timeout: 20_000 }); } catch { /* */ }
  if (sb && !KEEP) {
    const ok = sandboxDown(REPO, SANDBOX);
    log(ok ? `[e2e] sandbox "${SANDBOX}" torn down (${reason})` : `[e2e] WARNING: sandbox:down failed; run: bun run sandbox:down --name ${SANDBOX}`);
  } else if (sb) {
    log(`[e2e] E2E_KEEP=1: sandbox left running at ${sb.base}; stop it with: bun run sandbox:down --name ${SANDBOX}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`\n[e2e] ${sig}: tearing down`);
    await teardown(sig);
    process.exit(130);
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (fs.existsSync(sandboxFile(SANDBOX))) {
    console.error(`[e2e] A sandbox named "${SANDBOX}" already exists (${sandboxFile(SANDBOX)}).\n      Another run may be using it. If not, run: bun run sandbox:down --name ${SANDBOX}`);
    process.exit(2);
  }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  for (const f of fs.readdirSync(RESULTS)) if (/-fail\.png$/.test(f)) fs.rmSync(path.join(RESULTS, f));
  for (const f of fs.readdirSync(VIDEO_DIR)) fs.rmSync(path.join(VIDEO_DIR, f));
  const configPath = path.join(RESULTS, '.agent-browser.json');
  fs.writeFileSync(configPath, '{}\n'); // ignore any user-level agent-browser config

  const startedAt = now();
  const t0 = Date.now();
  log(`[e2e] starting sandbox "${SANDBOX}"…`);
  sb = sandboxUp(REPO, SANDBOX);
  log(`[e2e] sandbox up at ${sb.base} (pid ${sb.pid})`);

  ab = new AgentBrowser({ session: `wilson-e2e-${process.pid}`, namespace: 'wilson-e2e', headed: HEADED, configPath });
  const version = (await ab.run(['--version'])).stdout.trim();
  if (!version.includes(AGENT_BROWSER_VERSION)) throw new Error(`agent-browser ${version}, need ${AGENT_BROWSER_VERSION} (cd e2e && npm install)`);
  await ab.must(['open', 'about:blank'], { timeout: 90_000 });
  await ab.must(['set', 'viewport', '1280', '900']);

  const results = {
    meta: {
      startedAt,
      agentBrowser: version,
      chrome: ab.env.AGENT_BROWSER_EXECUTABLE_PATH ?? 'agent-browser default (Chrome for Testing)',
      sandbox: { name: SANDBOX, base: sb.base, auth: sb.auth },
      samples: SAMPLES,
      record: RECORD,
      headed: HEADED,
      only: ONLY,
      targets: TARGETS,
    },
    summary: null,
    paths: [],
    perf: null,
    mutations: { samples: [], stats: null },
    errors: { console: [], page: [], http5xx: [], server: [] },
    webmcp: { catalog: [], byTab: {}, meta: {}, invoked: {} },
    coverage: { tabs: Object.fromEntries(TABS.map((t) => [t, []])), webmcpTools: {} },
    notes: [],
  };

  const state = { adminSession: false };
  const passed = new Set();
  let logOffset = 0;

  const selected = ONLY ? withDeps(ONLY) : PATHS.map((p) => p.id);

  for (const def of PATHS) {
    if (!selected.includes(def.id)) continue;
    const pr = { id: def.id, name: def.name, tab: def.tab, covers: def.covers, status: 'passed', ms: 0, steps: [], notes: [], video: null, failShot: null, skipReason: null, errors: {} };
    results.paths.push(pr);
    const visits = new Set([def.tab]);

    // Dependencies: an earlier path (P01) or the admin session it leaves behind.
    const missing = (def.needs ?? []).filter((n) => (n === 'admin' ? !state.adminSession : !passed.has(n)));
    if (missing.length) {
      pr.status = 'skipped';
      pr.skipReason = `missing prerequisite: ${missing.join(', ')}`;
      log(`[e2e] ${def.id} SKIPPED — ${pr.skipReason}`);
      continue;
    }

    // Each path starts from a fresh load of Overview (no dialog or half-done form left by the previous path).
    if (def.id !== 'P01' && state.adminSession) {
      await ab.run(['open', 'about:blank']);
      await ab.run(['open', `${sb.base}/#overview`], { timeout: 60_000 });
      try {
        await waitFor(ab, `[...document.querySelectorAll('nav button')].some((b) => b.innerText.trim() === 'Overview')`, { timeout: 20_000, what: 'dashboard nav' });
      } catch (e) { /* the path's first step will fail and say why */ }
    }
    await ab.run(['console', '--clear']);
    await ab.run(['errors', '--clear']);
    await ab.run(['network', 'requests', '--clear']);
    if (RECORD) {
      const file = path.join(VIDEO_DIR, `${def.id}.webm`);
      const r = await ab.run(['record', 'start', file], { timeout: 30_000 });
      recording = r.ok;
      if (r.ok) pr.video = path.relative(E2E_DIR, file);
      else pr.notes.push(`recording failed to start: ${String(r.error).slice(0, 200)}`);
    }

    log(`[e2e] ${def.id} ${def.name}`);
    const pStart = Date.now();
    let failed = false;
    const ctx = {
      ab, sb, base: sb.base, state, e2eDir: E2E_DIR, resultsDir: RESULTS, webmcp: results.webmcp,
      visit: (tab) => visits.add(tab),
      note: (n) => pr.notes.push(n),
      mutation: (label, ms) => results.mutations.samples.push({ path: def.id, label, ms }),
      skip: (reason) => { throw new SkipError(reason); },
      step: async (name, fn) => {
        const s = { name, status: 'passed', ms: 0 };
        pr.steps.push(s);
        if (failed) { s.status = 'skipped'; s.reason = 'an earlier step failed'; return; }
        const st = Date.now();
        try {
          await fn();
        } catch (e) {
          if (e instanceof SkipError) { s.status = 'skipped'; s.reason = e.message; }
          else { s.status = 'failed'; s.error = String(e?.message ?? e).slice(0, 800); failed = true; }
        }
        s.ms = Date.now() - st;
        const mark = s.status === 'passed' ? 'ok ' : s.status === 'skipped' ? 'skip' : 'FAIL';
        log(`       ${mark} ${String(s.ms).padStart(6)} ms  ${name}${s.reason ? ` — ${s.reason}` : ''}${s.error ? `\n            ${s.error}` : ''}`);
      },
    };
    for (const t of tabsTouched(def)) visits.add(t);
    try {
      await def.run(ctx);
    } catch (e) {
      failed = true;
      pr.steps.push({ name: '(path body)', status: 'failed', ms: 0, error: String(e?.message ?? e).slice(0, 800) });
    }
    pr.ms = Date.now() - pStart;
    if (failed) {
      pr.status = 'failed';
      const shot = path.join(RESULTS, `${def.id}-fail.png`);
      const r = await ab.run(['screenshot', shot]);
      if (r.ok) pr.failShot = path.relative(E2E_DIR, shot);
    } else if (pr.steps.length > 0 && pr.steps.every((s) => s.status === 'skipped')) {
      pr.status = 'skipped';
      pr.skipReason = pr.steps.map((s) => s.reason).join('; ');
    } else {
      passed.add(def.id);
    }
    if (RECORD && recording) {
      const r = await ab.run(['record', 'stop'], { timeout: 60_000 });
      recording = false;
      if (!r.ok) pr.notes.push(`record stop failed: ${String(r.error).slice(0, 200)}`);
    }

    // Errors attributed to this path.
    const cons = (await ab.run(['console'], { json: true })).json?.data?.messages ?? [];
    const pageErrs = (await ab.run(['errors'], { json: true })).json?.data?.errors ?? [];
    const reqs = (await ab.run(['network', 'requests'], { json: true })).json?.data?.requests ?? [];
    const consErr = cons.filter((m) => m.type === 'error').map((m) => ({ path: def.id, text: String(m.text ?? '').slice(0, 400) }));
    const pageErr = pageErrs.map((m) => ({ path: def.id, text: String(m.message ?? m.text ?? JSON.stringify(m)).slice(0, 400) }));
    const http5 = reqs.filter((r) => Number(r.status) >= 500).map((r) => ({ path: def.id, method: r.method, url: r.url, status: r.status }));
    const http4 = reqs.filter((r) => Number(r.status) >= 400 && Number(r.status) < 500).map((r) => `${r.method} ${new URL(r.url).pathname} ${r.status}`);
    const srv = serverLogErrors(sb.log, logOffset);
    logOffset = srv.size;
    results.errors.console.push(...consErr);
    results.errors.page.push(...pageErr);
    results.errors.http5xx.push(...http5);
    results.errors.server.push(...srv.lines.map((l) => ({ path: def.id, line: l })));
    pr.errors = { console: consErr.length, page: pageErr.length, http5xx: http5.length, server: srv.lines.length, http4xx: [...new Set(http4)] };
    for (const t of visits) if (results.coverage.tabs[t] && !results.coverage.tabs[t].includes(def.id)) results.coverage.tabs[t].push(def.id);
    log(`       => ${pr.status.toUpperCase()} (${pr.ms} ms)`);
  }

  // ── perf ───────────────────────────────────────────────────────────────────
  if (PERF && state.adminSession) {
    log(`[e2e] perf: ${SAMPLES} sample(s) per tab, desktop 1280x900 and phone 390x844${THROTTLE ? ' + mobile4g (CDP)' : ''}`);
    results.perf = await samplePerf();
  } else {
    results.perf = { skipped: PERF ? 'no admin session' : 'E2E_PERF=0' };
  }

  // ── summary ────────────────────────────────────────────────────────────────
  results.mutations.stats = summarize(results.mutations.samples.map((m) => m.ms));
  const inv = results.webmcp;
  const allTools = new Set([...(inv.catalog ?? []), ...Object.values(inv.byTab).flat()]);
  for (const name of [...allTools].sort()) {
    results.coverage.webmcpTools[name] = !!inv.invoked[name]?.covered;
  }
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const p of results.paths) counts[p.status]++;
  const perfD = results.perf?.desktop?.overall;
  const perfM = results.perf?.mobile?.overall;
  results.summary = {
    ...counts,
    total: results.paths.length,
    durationMs: Date.now() - t0,
    nn10: {
      mutationP95Ms: { value: results.mutations.stats.p95, target: `< ${TARGETS.mutationP95Ms}`, pass: results.mutations.stats.p95 !== null ? results.mutations.stats.p95 < TARGETS.mutationP95Ms : null },
      lcpP75MsMobile: { value: perfM?.lcp?.p75 ?? null, profile: results.perf?.mobile?.profile ?? null, target: `< ${TARGETS.lcpP75MsMobile4g}`, pass: perfM?.lcp?.p75 != null ? perfM.lcp.p75 < TARGETS.lcpP75MsMobile4g : null },
      clsP75: { desktop: perfD?.cls?.p75 ?? null, mobile: perfM?.cls?.p75 ?? null, target: `< ${TARGETS.clsP75}`, pass: perfD?.cls?.p75 != null ? Math.max(perfD.cls.p75, perfM?.cls?.p75 ?? 0) < TARGETS.clsP75 : null },
      horizontalScrollAt360: { tabsWithPageScroll: results.perf?.overflow360 ? Object.entries(results.perf.overflow360).filter(([, v]) => v.pageScroll).map(([k]) => k) : null, pass: results.perf?.overflow360 ? Object.values(results.perf.overflow360).every((v) => !v.pageScroll) : null },
      layoutAt360: layoutVerdict(results.perf?.layout360),
    },
    errors: { console: results.errors.console.length, page: results.errors.page.length, http5xx: results.errors.http5xx.length, server: results.errors.server.length },
    webmcp: { tools: allTools.size, covered: Object.values(results.coverage.webmcpTools).filter(Boolean).length },
  };
  results.meta.finishedAt = now();
  fs.writeFileSync(path.join(RESULTS, 'latest.json'), JSON.stringify(results, null, 2));
  printSummary(results);
  return counts.failed > 0 ? 1 : 0;
}

function withDeps(ids) {
  const out = new Set(ids);
  if (ids.some((id) => id !== 'P01')) out.add('P01');
  for (const id of ids) for (const n of PATHS.find((p) => p.id === id)?.needs ?? []) if (n !== 'admin') out.add(n);
  return PATHS.map((p) => p.id).filter((id) => out.has(id));
}

/** Tabs a path's body navigates to, read from its source (gotoTab labels). */
function tabsTouched(def) {
  const src = def.run.toString();
  return [...src.matchAll(/gotoTab\(ab, '([A-Za-z]+)'/g)].map((m) => m[1].toLowerCase()).filter((t) => TABS.includes(t));
}

async function samplePerf() {
  const out = { samplesPerTab: SAMPLES, method: 'full reload per sample (about:blank -> base/#tab), buffered PerformanceObserver (LCP, layout-shift), navigation + paint timing', desktop: null, mobile: null, overflow360: null, layout360: null };
  const run = async (label, viewport, throttle) => {
    await ab.must(['set', 'viewport', String(viewport[0]), String(viewport[1])]);
    let th = null;
    if (throttle) {
      try {
        const cdp = (await ab.must(['get', 'cdp-url'])).stdout.trim();
        th = await throttlePage(cdp, { urlPrefix: sb.base });
      } catch (e) {
        out.notes = [...(out.notes ?? []), `throttling unavailable: ${e.message}`];
      }
    }
    const byTab = {};
    try {
      for (const tab of TABS) {
        byTab[tab] = [];
        for (let i = 0; i < SAMPLES; i++) {
          await ab.must(['open', 'about:blank']);
          const t0 = Date.now();
          await ab.must(['open', `${sb.base}/#${tab}`], { timeout: 120_000 });
          try {
            await waitFor(ab, `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(${JSON.stringify(TAB_READY[tab])})`, { timeout: throttle ? 90_000 : 20_000, what: `${tab} ready` });
          } catch (e) {
            byTab[tab].push({ error: e.message });
            continue;
          }
          const readyMs = Date.now() - t0;
          await sleep(throttle ? 1500 : 600);
          const v = await ab.eval(VITALS_JS);
          byTab[tab].push({ ...v, readyMs });
        }
        log(`       ${label} ${tab.padEnd(13)} lcp p50 ${String(percentile(byTab[tab].map((s) => s.lcp), 50)).padStart(7)} ms  cls p50 ${percentile(byTab[tab].map((s) => s.cls), 50)}`);
      }
    } finally {
      if (th) await th.release();
    }
    const per = {};
    for (const [tab, xs] of Object.entries(byTab)) {
      per[tab] = { samples: xs, ttfb: summarize(xs.map((s) => s.ttfb)), fcp: summarize(xs.map((s) => s.fcp)), lcp: summarize(xs.map((s) => s.lcp)), cls: summarize(xs.map((s) => s.cls)) };
    }
    const all = Object.values(byTab).flat();
    return {
      viewport,
      profile: throttle ? (th ? { name: 'mobile4g', ...MOBILE4G, via: 'raw CDP (agent-browser has no throttle command)' } : 'unthrottled (CDP throttle failed)') : 'unthrottled',
      tabs: per,
      overall: { ttfb: summarize(all.map((s) => s.ttfb)), fcp: summarize(all.map((s) => s.fcp)), lcp: summarize(all.map((s) => s.lcp)), cls: summarize(all.map((s) => s.cls)) },
    };
  };
  out.desktop = await run('desktop', [1280, 900], false);
  out.mobile = await run('mobile ', [390, 844], THROTTLE);

  // No horizontal scroll at 360 px (NN-10): every tab, unthrottled.
  await ab.must(['set', 'viewport', '360', '800']);
  await ab.must(['open', 'about:blank']);
  await ab.must(['open', `${sb.base}/#overview`]);
  out.overflow360 = {};
  out.layout360 = {};
  for (const tab of TABS) {
    await ab.eval(`(() => { location.hash = ${JSON.stringify('#' + tab)}; return true; })()`);
    try { await waitFor(ab, `(document.querySelector('main')?.innerText ?? '').toLowerCase().includes(${JSON.stringify(TAB_READY[tab])})`, { timeout: 20_000 }); } catch { /* measured anyway */ }
    await sleep(500);
    out.overflow360[tab] = await ab.eval(OVERFLOW_JS);
    out.layout360[tab] = await ab.eval(LAYOUT_AUDIT_JS);
  }
  await ab.must(['set', 'viewport', '1280', '900']);
  return out;
}

/** NN-10 layout audit verdict: offenders per tab (rule, selector, size) from LAYOUT_AUDIT_JS at 360x800. */
function layoutVerdict(byTab) {
  const base = { rules: 'offscreen (right edge past viewport outside an overflow-x scroller), clipped (overflow hidden + scrollWidth > clientWidth on text), narrowtext (<120 px wide, >4 lines), smalltarget (<24x24 interactive)' };
  if (!byTab) return { ...base, value: null, offenders: null, pass: null };
  const offenders = {};
  const value = {};
  const truncated = {};
  for (const [tab, r] of Object.entries(byTab)) {
    if (r?.offenders?.length) { offenders[tab] = r.offenders; value[tab] = r.total ?? r.offenders.length; if (r.truncated) truncated[tab] = { shown: r.offenders.length, total: r.total }; }
  }
  return { ...base, value, offenders, ...(Object.keys(truncated).length ? { truncated } : {}), pass: Object.keys(offenders).length === 0 };
}

function printSummary(r) {
  const s = r.summary;
  log('\n────────────────────────────────────────────────────────────────────');
  log(`Wilson e2e: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${(s.durationMs / 1000).toFixed(0)} s)`);
  for (const p of r.paths) {
    const steps = p.steps.filter((x) => x.status === 'passed').length + '/' + p.steps.length;
    log(`  ${p.id} ${p.status.padEnd(7)} ${String(p.ms).padStart(7)} ms  steps ${steps.padEnd(6)} ${p.name}${p.skipReason ? ` — ${p.skipReason}` : ''}`);
  }
  const n = s.nn10;
  const v = (x) => (x.pass === null ? 'n/a' : x.pass ? 'PASS' : 'FAIL');
  log(`NN-10 mutations p95 ${n.mutationP95Ms.value} ms (target ${n.mutationP95Ms.target}) ${v(n.mutationP95Ms)}`);
  log(`NN-10 LCP p75 mobile ${n.lcpP75MsMobile.value} ms (target ${n.lcpP75MsMobile.target}) ${v(n.lcpP75MsMobile)}`);
  log(`NN-10 CLS p75 desktop ${n.clsP75.desktop} / mobile ${n.clsP75.mobile} (target ${n.clsP75.target}) ${v(n.clsP75)}`);
  log(`NN-10 no horizontal scroll at 360 px: ${v(n.horizontalScrollAt360)}${n.horizontalScrollAt360.tabsWithPageScroll?.length ? ` (${n.horizontalScrollAt360.tabsWithPageScroll.join(', ')})` : ''}`);
  const L = n.layoutAt360;
  log(`NN-10 phone layout audit at 360 px: ${v(L)}`);
  for (const [tab, offs] of Object.entries(L.offenders ?? {})) {
    log(`       ${tab}: ${offs.length} offender(s)`);
    for (const o of offs.slice(0, 12)) log(`         [${o.rule}] ${o.selector} ${o.w}x${o.h}${o.text ? ` "${o.text}"` : ''}`);
  }
  log(`errors: console ${s.errors.console}, page ${s.errors.page}, http 5xx ${s.errors.http5xx}, server log ${s.errors.server}`);
  log(`WebMCP: ${s.webmcp.covered}/${s.webmcp.tools} tools exercised`);
  log(`results: ${path.join(RESULTS, 'latest.json')}`);
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`[e2e] fatal: ${e?.stack ?? e}`);
  code = 1;
} finally {
  await teardown('exit');
}
process.exit(code);
