#!/usr/bin/env node
// Turn e2e/results/latest.json + e2e/results/video/<ID>.webm into one summary MP4 with HyperFrames.
//
//   node e2e/reel/build.mjs [--results e2e/results] [--out e2e/results/reel.mp4] [--clip-max 8] [--no-render]
//
// 1. Each path's webm is sped up (ffmpeg setpts) to at most --clip-max seconds and written as H.264 into the build dir,
//    so the composition stays short and every clip plays at 1x inside HyperFrames.
// 2. index.html (a HyperFrames composition: GSAP timeline on window.__timelines["main"]) gets a title card with the
//    pass/fail/skip counts, one segment per path (clip + ID / name / result lower-third), and a closing coverage card.
// 3. Renders with the pinned CLI: npx --yes hyperframes@0.8.123 render (HYPERFRAMES_SKIP_SKILLS=1).
// Nothing in the composition is invented: every number and label comes from latest.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.resolve(HERE, '..');
const HF = 'hyperframes@0.8.123';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const RESULTS = path.resolve(opt('results', path.join(E2E, 'results')));
const OUT = path.resolve(opt('out', path.join(RESULTS, 'reel.mp4')));
const CLIP_MAX = Number(opt('clip-max', 8));
const RENDER = !args.includes('--no-render');
const BUILD = path.join(HERE, 'build');

const W = 1920, H = 1080, FPS = 30;
const TITLE_S = 4, CARD_S = 2.5, END_S = 6;

const latest = JSON.parse(fs.readFileSync(path.join(RESULTS, 'latest.json'), 'utf8'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}
const probeDuration = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD, 'assets'), { recursive: true });
for (const f of ['hyperframes.json', 'package.json']) fs.copyFileSync(path.join(HERE, f), path.join(BUILD, f));
fs.writeFileSync(path.join(BUILD, 'meta.json'), JSON.stringify({ id: 'wilson-e2e-reel', name: 'wilson-e2e-reel', createdAt: latest.meta?.finishedAt ?? latest.meta?.startedAt }, null, 2));

// ── clips ────────────────────────────────────────────────────────────────────
const segments = [];
let t = TITLE_S;
for (const p of latest.paths) {
  const src = p.video ? path.resolve(E2E, p.video) : null;
  let clip = null;
  if (src && fs.existsSync(src) && fs.statSync(src).size > 0) {
    const raw = probeDuration(src);
    if (Number.isFinite(raw) && raw > 0.3) {
      const speed = raw > CLIP_MAX ? raw / CLIP_MAX : 1;
      const dur = Math.max(1.5, Math.min(raw, CLIP_MAX));
      const file = `assets/${p.id}.mp4`;
      run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `setpts=PTS/${speed.toFixed(4)},fps=${FPS},scale=1280:-2`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-t', dur.toFixed(3), path.join(BUILD, file)]);
      clip = { file, dur: Math.min(dur, probeDuration(path.join(BUILD, file))), speed, raw };
    }
  }
  const dur = clip ? clip.dur : CARD_S;
  segments.push({ p, clip, start: t, dur });
  t += dur;
}
const TOTAL = +(t + END_S).toFixed(3);

// ── copy ─────────────────────────────────────────────────────────────────────
const s = latest.summary ?? {};
const nn = s.nn10 ?? {};
const fmtMs = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v).toLocaleString('en-US')} ms`);
const verdict = (x) => (x?.pass === true ? 'pass' : x?.pass === false ? 'fail' : 'na');
const stepCount = (p) => `${p.steps.filter((x) => x.status === 'passed').length}/${p.steps.length} steps`;
const when = new Date(latest.meta?.startedAt ?? Date.now()).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const tabs = Object.entries(latest.coverage?.tabs ?? {});
const tools = Object.entries(latest.coverage?.webmcpTools ?? {});
const covered = tools.filter(([, v]) => v).length;
const uncovered = tools.filter(([, v]) => !v).map(([k]) => k);
const errs = s.errors ?? {};

const segHtml = segments.map(({ p, clip, start, dur }, i) => {
  const cls = p.status === 'passed' ? 'ok' : p.status === 'failed' ? 'bad' : 'skip';
  const failStep = p.steps.find((x) => x.status === 'failed');
  const sub = p.status === 'skipped' ? (p.skipReason ?? '') : failStep ? `failed at: ${failStep.name}` : `${stepCount(p)} · ${(p.ms / 1000).toFixed(1)} s`;
  const media = clip
    ? `  <video id="v${i}" class="clip vid" src="${clip.file}" data-start="${start.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-media-start="0" data-track-index="1" muted playsinline></video>`
    : `  <div id="v${i}" class="clip novid" data-start="${start.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-track-index="1"><div>${esc(p.id)} · no recording</div></div>`;
  return `${media}
  <div id="lt${i}" class="clip lt" data-start="${start.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-track-index="2">
    <div class="ltid">${esc(p.id)}</div>
    <div class="ltbody"><div class="ltname">${esc(p.name)}</div><div class="ltsub">${esc(sub)}</div></div>
    <div class="chip ${cls}">${esc(p.status.toUpperCase())}</div>
    ${clip && clip.speed > 1.05 ? `<div class="speed">${clip.speed.toFixed(1)}× speed</div>` : ''}
  </div>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
:root{--money:#22c55e;--ledger:#e5e7eb;--ink:#9ca3af;--slate:#1f2937;--void:#111827;--deep:#0a0f1a;--alert:#ef4444;--caution:#f59e0b}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:var(--deep)}
#root{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:var(--deep);font-family:Inter,system-ui,sans-serif;color:var(--ledger)}
.mono{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}
.card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 160px;background:var(--deep)}
.kicker{font:700 22px 'JetBrains Mono',monospace;letter-spacing:.2em;color:var(--money);text-transform:uppercase}
h1{font:700 96px 'Space Grotesk',sans-serif;margin:18px 0 10px}
h1 b{color:var(--money)}
.subtitle{font-size:30px;color:var(--ink)}
.counts{display:flex;gap:28px;margin-top:56px}
.count{border:2px solid var(--slate);border-radius:14px;padding:22px 34px;min-width:220px;background:var(--void)}
.count .n{font:700 72px 'Space Grotesk',sans-serif}
.count .l{font:600 20px 'JetBrains Mono',monospace;letter-spacing:.12em;color:var(--ink);text-transform:uppercase}
.count.ok .n{color:var(--money)} .count.bad .n{color:var(--alert)} .count.skip .n{color:var(--caution)}
.nn{margin-top:40px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 40px;font:400 24px 'JetBrains Mono',monospace;color:var(--ink)}
.nn span.pass{color:var(--money)} .nn span.fail{color:var(--alert)} .nn span.na{color:var(--ink)}
.vid{position:absolute;left:${(W - 1280 * (920 / 900)) / 2}px;top:20px;width:${Math.round(1280 * (920 / 900))}px;height:920px;object-fit:contain;background:#000;border-radius:10px}
.novid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 40px 'JetBrains Mono',monospace;color:var(--ink)}
.lt{position:absolute;left:80px;right:80px;bottom:36px;height:118px;display:flex;align-items:center;gap:28px;padding:0 32px;background:rgba(10,15,26,.94);border:1px solid rgba(156,163,175,.35);border-left:6px solid var(--money);border-radius:12px}
.ltid{font:700 44px 'JetBrains Mono',monospace;color:var(--money)}
.ltbody{flex:1;min-width:0}
.ltname{font:600 34px Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ltsub{font:400 22px 'JetBrains Mono',monospace;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.chip{font:700 26px 'JetBrains Mono',monospace;padding:10px 20px;border-radius:8px;letter-spacing:.08em}
.chip.ok{background:rgba(34,197,94,.15);color:var(--money)} .chip.bad{background:rgba(239,68,68,.15);color:var(--alert)} .chip.skip{background:rgba(245,158,11,.15);color:var(--caution)}
.speed{font:600 20px 'JetBrains Mono',monospace;color:var(--caution)}
.cov{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:36px}
.cov h2{font:700 26px 'JetBrains Mono',monospace;letter-spacing:.12em;color:var(--money);text-transform:uppercase;margin-bottom:16px}
.row{font:400 24px 'JetBrains Mono',monospace;color:var(--ledger);line-height:1.55}
.row .dim{color:var(--ink)}
.warn{color:var(--caution)}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="${W}" data-height="${H}">
  <div id="title" class="clip card" data-start="0" data-duration="${TITLE_S}" data-track-index="3">
    <div class="kicker">bun run e2e · agent-browser ${esc(String(latest.meta?.agentBrowser ?? '').replace(/^agent-browser\s*/, ''))}</div>
    <h1>Wilson <b>critical paths</b></h1>
    <div class="subtitle">${esc(when)} · throwaway sandbox, FAKE seed data · ${latest.paths.length} paths</div>
    <div class="counts">
      <div class="count ok"><div class="n">${s.passed ?? 0}</div><div class="l">passed</div></div>
      <div class="count bad"><div class="n">${s.failed ?? 0}</div><div class="l">failed</div></div>
      <div class="count skip"><div class="n">${s.skipped ?? 0}</div><div class="l">skipped</div></div>
    </div>
    <div class="nn">
      <div>mutation p95 <span class="${verdict(nn.mutationP95Ms)}">${fmtMs(nn.mutationP95Ms?.value)}</span> (&lt; 300)</div>
      <div>LCP p75 mobile4g <span class="${verdict(nn.lcpP75MsMobile)}">${fmtMs(nn.lcpP75MsMobile?.value)}</span> (&lt; 2000)</div>
      <div>CLS p75 <span class="${verdict(nn.clsP75)}">${nn.clsP75?.desktop ?? 'n/a'} / ${nn.clsP75?.mobile ?? 'n/a'}</span> (&lt; 0.1)</div>
      <div>360 px no h-scroll <span class="${verdict(nn.horizontalScrollAt360)}">${nn.horizontalScrollAt360?.pass === null || nn.horizontalScrollAt360?.pass === undefined ? 'n/a' : nn.horizontalScrollAt360.pass ? 'yes' : 'no'}</span></div>
    </div>
  </div>
${segHtml}
  <div id="end" class="clip card" data-start="${(TOTAL - END_S).toFixed(3)}" data-duration="${END_S}" data-track-index="3">
    <div class="kicker">coverage</div>
    <div class="cov">
      <div>
        <h2>Tabs → paths</h2>
        ${tabs.map(([tab, ids]) => `<div class="row">${esc(tab.padEnd(13, ' ')).replace(/ /g, '&nbsp;')}<span class="${ids.length ? '' : 'warn'}">${ids.length ? esc(ids.join(' ')) : 'not covered'}</span></div>`).join('\n        ')}
      </div>
      <div>
        <h2>WebMCP tools exercised: ${covered}/${tools.length}</h2>
        <div class="row dim">${esc(uncovered.length ? `not exercised: ${uncovered.join(', ')}` : 'every listed tool was invoked')}</div>
        <h2 style="margin-top:36px">Errors seen</h2>
        <div class="row">console ${errs.console ?? 0} · page ${errs.page ?? 0} · HTTP 5xx ${errs.http5xx ?? 0} · server log ${errs.server ?? 0}</div>
        <div class="row dim" style="margin-top:28px">full detail: e2e/results/latest.json</div>
      </div>
    </div>
  </div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.fromTo("#title", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0).to("#title", { opacity: 0, duration: 0.3 }, ${TITLE_S - 0.3});
const segs = ${JSON.stringify(segments.map((g, i) => ({ i, a: +g.start.toFixed(3), d: +g.dur.toFixed(3) })))};
segs.forEach((g) => {
  tl.fromTo("#lt" + g.i, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power2.out", immediateRender: false }, g.a + 0.1);
});
tl.fromTo("#end", { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, ${(TOTAL - END_S).toFixed(3)});
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(BUILD, 'index.html'), html);
console.log(`[reel] composition: ${path.join(BUILD, 'index.html')} (${TOTAL}s, ${segments.length} path segments, ${segments.filter((g) => g.clip).length} with video)`);

if (!RENDER) process.exit(0);
const env = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' };
spawnSync('npx', ['--yes', HF, 'telemetry', 'disable'], { cwd: BUILD, env, stdio: 'ignore' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const r = spawnSync('npx', ['--yes', HF, 'render', '--quiet', '-o', OUT], { cwd: BUILD, env, stdio: 'inherit' });
if (r.status !== 0 || !fs.existsSync(OUT)) {
  console.error(`[reel] render failed (exit ${r.status}). The composition is in ${BUILD}; try: (cd ${BUILD} && npx --yes ${HF} render -o ${OUT})`);
  process.exit(1);
}
console.log(`[reel] ${OUT} (${probeDuration(OUT).toFixed(1)} s)`);
