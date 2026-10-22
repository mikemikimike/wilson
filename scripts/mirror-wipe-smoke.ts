#!/usr/bin/env bun
/**
 * Browser smoke check for the offline mirror's session wipe: runs the REAL mirror worker
 * (src/dashboard/ui/src/store/mirror-worker.ts, real wa-sqlite + AccessHandlePoolVFS on real OPFS) in headless
 * Chromium and checks that a wipe leaves no wilson-mirror-* directory behind. The bun tests pin the wiring by
 * source and fake the OPFS root, so they cannot see an access handle that is still open; this can.
 *
 *   bun run scripts/mirror-wipe-smoke.ts
 *
 * Checks:
 *   1. While the worker has the pool open, the main thread cannot remove it (the handles are really held).
 *   2. The worker's 'wipe' closes the pool and removes it itself: { removed: [profile], failed: [] }, OPFS empty.
 *   3. The fallback after terminate(): the pool of a worker terminated a moment ago is removed by
 *      removeMirrorPools with POOL_RELEASE_RETRY_MS (mirror-client.ts doWipe).
 *   4. listMirrorPoolProfiles reads every pool on the real OPFS root (keys() on a real directory handle), including
 *      one no longer open, and a wipe of that list leaves none.
 *
 * Touches nothing outside a throwaway Chromium profile (no ~/.openaccountant, no keychain, no server).
 * Exits non-zero on any failed check.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const uiDir = join(import.meta.dir, '../src/dashboard/ui');
const storeDir = join(uiDir, 'src/store');
const requireUi = createRequire(join(uiDir, 'package.json'));
const wasmPath = join(dirname(requireUi.resolve('wa-sqlite/package.json')), 'dist/wa-sqlite.wasm');

const wasmInline: import('bun').BunPlugin = {
  name: 'wa-sqlite-wasm-inline',
  setup(build) {
    build.onResolve({ filter: /^virtual:wa-sqlite-wasm$/ }, () => ({ path: 'wa-sqlite-wasm', namespace: 'wasm-inline' }));
    build.onLoad({ filter: /.*/, namespace: 'wasm-inline' }, () => ({
      contents: `export default ${JSON.stringify(readFileSync(wasmPath).toString('base64'))};`,
      loader: 'js',
    }));
  },
};

async function bundle(entry: string): Promise<string> {
  const out = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', plugins: [wasmInline] });
  if (!out.success) throw new AggregateError(out.logs, `bundle failed: ${entry}`);
  return out.outputs[0]!.text();
}

const workerJs = await bundle(join(storeDir, 'mirror-worker.ts'));
const pageEntry = join(import.meta.dir, '.mirror-wipe-smoke-page.ts');
await Bun.write(
  pageEntry,
  `import { POOL_RELEASE_RETRY_MS, listMirrorPoolProfiles, removeMirrorPools } from ${JSON.stringify(join(storeDir, 'mirror-session.ts'))};\n` +
    `(globalThis as any).smoke = { POOL_RELEASE_RETRY_MS, listMirrorPoolProfiles, removeMirrorPools };\n`,
);
let pageJs: string;
try {
  pageJs = await bundle(pageEntry);
} finally {
  await Bun.file(pageEntry).delete();
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/worker.js') return new Response(workerJs, { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/page.js') return new Response(pageJs, { headers: { 'content-type': 'text/javascript' } });
    return new Response('<!doctype html><script type="module" src="/page.js"></script>', { headers: { 'content-type': 'text/html' } });
  },
});

const browser = await chromium.launch();
let failures = 0;
function check(label: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => (globalThis as any).smoke !== undefined);

  const result = await page.evaluate(async () => {
    const smoke = (globalThis as any).smoke;
    const root = await navigator.storage.getDirectory();
    const list = async () => {
      const names: string[] = [];
      for await (const [name] of (root as any).entries()) names.push(name);
      return names.filter((n) => n.startsWith('wilson-mirror-')).sort();
    };
    const spawn = () => {
      const w = new Worker('/worker.js', { type: 'module' });
      let id = 0;
      const rpc = (type: string, extra: Record<string, unknown> = {}) =>
        new Promise<any>((resolve, reject) => {
          const mine = ++id;
          const onMessage = (e: MessageEvent) => {
            if (e.data?.id !== mine) return;
            w.removeEventListener('message', onMessage);
            if (e.data.ok) resolve(e.data.result);
            else reject(new Error(e.data.error));
          };
          w.addEventListener('message', onMessage);
          w.postMessage({ id: mine, type, ...extra });
        });
      return { w, rpc };
    };
    const errorName = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (err) {
        return (err as { name?: string }).name ?? String(err);
      }
    };

    // 1 + 2: the worker owns the pool; its wipe must remove it.
    const a = spawn();
    const opened = await a.rpc('init', { profile: 'smoke-a' });
    const afterOpen = await list();
    const heldError = await errorName(() => root.removeEntry('wilson-mirror-smoke-a', { recursive: true }));
    const wiped = await a.rpc('wipe', { profiles: ['smoke-a'] });
    const afterWipe = await list();
    a.w.terminate();

    // 3: terminate a worker that has its pool open, then remove from the main thread at once, with the backoff.
    const b = spawn();
    await b.rpc('init', { profile: 'smoke-b' });
    b.w.terminate();
    const fallback = await smoke.removeMirrorPools(root, ['smoke-b'], { retryDelaysMs: smoke.POOL_RELEASE_RETRY_MS });
    const afterFallback = await list();

    // 4: two pools on disk (the first closed when the worker switched profile); the listing finds both.
    const c = spawn();
    await c.rpc('init', { profile: 'smoke-c' });
    await c.rpc('setProfile', { profile: 'smoke d/e' });
    const listed = (await smoke.listMirrorPoolProfiles(root)).sort();
    const listedWipe = await c.rpc('wipe', { profiles: listed });
    const afterListedWipe = await list();
    c.w.terminate();

    return { opened, afterOpen, heldError, wiped, afterWipe, fallback, afterFallback, listed, listedWipe, afterListedWipe };
  });

  check('worker opened the pool', result.afterOpen.includes('wilson-mirror-smoke-a'), result);
  check('main thread cannot remove a pool the worker holds', result.heldError === 'NoModificationAllowedError', result.heldError);
  check("worker's wipe removed the pool itself", JSON.stringify(result.wiped) === JSON.stringify({ removed: ['smoke-a'], failed: [] }), result.wiped);
  check('no pool left after the wipe', !result.afterWipe.includes('wilson-mirror-smoke-a'), result.afterWipe);
  check('backoff removes a just-terminated worker\'s pool', JSON.stringify(result.fallback) === JSON.stringify({ removed: ['smoke-b'], failed: [] }), result.fallback);
  check('no pool left after the fallback', result.afterFallback.length === 0, result.afterFallback);
  check('the OPFS listing finds every pool, open or not', JSON.stringify(result.listed) === JSON.stringify(['smoke d/e', 'smoke-c']), result.listed);
  check('a wipe of the listed pools leaves none', result.afterListedWipe.length === 0 && result.listedWipe.failed.length === 0, result);
} finally {
  await browser.close();
  server.stop(true);
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('mirror wipe smoke: all checks passed');
