// Sandbox lifecycle, percentiles and CDP throttling for the critical-path suite.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SANDBOX_ROOT = '/private/tmp/claude-501/wilson-sandbox';

// ── Sandbox ──────────────────────────────────────────────────────────────────

export function sandboxFile(name) {
  return path.join(SANDBOX_ROOT, name, 'sandbox.json');
}

/** `bun run sandbox:up --auth --name <name>`; returns the parsed sandbox.json. */
export function sandboxUp(repo, name) {
  const r = spawnSync('bun', ['run', 'sandbox:up', '--auth', '--name', name], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0 || !fs.existsSync(sandboxFile(name))) {
    throw new Error(`sandbox:up failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(fs.readFileSync(sandboxFile(name), 'utf8'));
}

export function sandboxDown(repo, name) {
  const r = spawnSync('bun', ['run', 'sandbox:down', '--name', name], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  return r.status === 0;
}

/** Error-level lines the dashboard wrote to its log (winston JSON or plain text). */
export function serverLogErrors(logPath, fromByte = 0) {
  if (!logPath || !fs.existsSync(logPath)) return { lines: [], size: 0 };
  const buf = fs.readFileSync(logPath);
  const text = buf.subarray(fromByte).toString('utf8');
  const lines = text.split('\n').filter((l) => {
    if (!l.trim()) return false;
    try {
      const j = JSON.parse(l);
      return /^(error|fatal)$/i.test(j.level ?? '');
    } catch {
      return /\b(error|exception|uncaught|unhandled)\b/i.test(l) && !/\b0 errors\b/i.test(l);
    }
  });
  return { lines: lines.map((l) => l.slice(0, 500)), size: buf.length };
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..100) of the finite numbers in `xs`; null when empty. */
export function percentile(xs, p) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(v.length, rank) - 1];
}

export function summarize(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return {
    n: v.length,
    p50: percentile(v, 50),
    p75: percentile(v, 75),
    p95: percentile(v, 95),
    max: v.length ? Math.max(...v) : null,
  };
}

// ── CDP throttling (agent-browser has no CPU/network throttle command) ───────
//
// Attaches a second CDP client to the session's page target and applies Lighthouse's "Slow 4G" mobile profile
// (150 ms RTT, 1.6 Mbps down, 750 Kbps up, 4x CPU). The emulation lasts while the socket stays open.

export const MOBILE4G = { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, cpu: 4 };

export async function throttlePage(cdpUrl, { urlPrefix, profile = MOBILE4G } = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket missing (needs Node >= 22)');
  const ws = new WebSocket(cdpUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && (!urlPrefix || t.url.startsWith(urlPrefix))) ?? targetInfos.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target to throttle');
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.downloadThroughput, uploadThroughput: profile.uploadThroughput }, sessionId);
  await send('Emulation.setCPUThrottlingRate', { rate: profile.cpu }, sessionId);
  return {
    profile,
    async release() {
      try {
        await send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId);
        await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
        await send('Target.detachFromTarget', { sessionId });
      } catch { /* socket may be gone */ }
      try { ws.close(); } catch { /* */ }
    },
  };
}
