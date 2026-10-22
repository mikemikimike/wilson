// @invariant NN-08
import { describe, expect, test, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * NN-08: tests and agents never touch real data. The sandbox scripts refuse to run against any HOME that is not a
 * throwaway directory under /private/tmp, and `sandbox:down` never deletes outside its root.
 *
 * Safety of this test itself: the real HOME (/Users/jdfiscus) is only ever handed to the side-effect-free guard module
 * (scripts/webmcp-live-seed-guard.ts, which only reads homedir()/HOME and exits). The scripts that would open a profile
 * and the keychain (enable-auth.ts) only ever get a fresh empty temp HOME, and the inherited PATH carries the
 * preload's `security` shim, so even a broken guard could not reach the real keychain from here.
 */

const ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = join(ROOT, 'scripts', 'webmcp-live-seed-guard.ts');
const ENABLE_AUTH = join(ROOT, 'scripts', 'sandbox', 'enable-auth.ts');
const DOWN = join(ROOT, 'scripts', 'sandbox', 'down.ts');
const REAL_HOME = '/Users/jdfiscus';
const SANDBOX_ROOT = '/private/tmp/claude-501/wilson-sandbox';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function run(script: string, home: string, args: string[] = []) {
  const r = Bun.spawnSync(['bun', script, ...args], {
    cwd: ROOT,
    // The transpiler cache would otherwise land in $HOME/Library/Caches/bun and muddy the "nothing created" check.
    env: { ...process.env, HOME: home, OA_DEBUG: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/** A fresh, empty HOME that is NOT under /private/tmp (os.tmpdir() is /var/folders/... on macOS, /tmp on Linux). */
function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'oa-guard-home-'));
  scratch.push(d);
  expect(d.includes('/private/tmp/')).toBe(false);
  return d;
}

describe('NN-08 HOME guard (scripts/webmcp-live-seed-guard.ts)', () => {
  test('refuses the real HOME', () => {
    const r = run(GUARD, REAL_HOME);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Refusing to seed');
  });

  test('refuses a HOME outside /private/tmp', () => {
    for (const home of [freshHome(), '/Users/someone-else', '/tmp/not-private']) {
      const r = run(GUARD, home);
      expect({ home, code: r.code }).toEqual({ home, code: 1 });
    }
  });

  test('accepts a scratch HOME under /private/tmp (control: the refusals above are not vacuous)', () => {
    const r = run(GUARD, '/private/tmp/claude-501/wilson-sandbox/guard-control-never-created');
    expect(r.code).toBe(0);
  });

  // FINDING: webmcp-live-seed-guard.ts:11 tests `home.includes('/private/tmp/')`, a substring, not "resolves under
  // /private/tmp". A HOME that merely contains that text passes: `/private/tmp/../../Users/jdfiscus` resolves to the
  // real home, and `/Users/jdfiscus/private/tmp/x` sits inside it. Only the side-effect-free guard module is run with
  // these values. Expected-fail until the guard resolves the path and checks the prefix.
  test.failing('refuses a HOME that only contains "/private/tmp/" but resolves elsewhere (FINDING: substring check)', () => {
    for (const home of ['/private/tmp/../../Users/jdfiscus', `${REAL_HOME}/private/tmp/x`]) {
      const r = run(GUARD, home);
      expect({ home, code: r.code }).toEqual({ home, code: 1 });
    }
  });
});

describe('NN-08 scripts/sandbox/enable-auth.ts refuses a non-sandbox HOME before touching anything', () => {
  test('non-zero exit and no file created under HOME', () => {
    const home = freshHome();
    const r = run(ENABLE_AUTH, home);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Refusing to seed');
    // The guard runs before any app module loads, so not even ~/.openaccountant/logs exists.
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(join(home, '.openaccountant'))).toBe(false);
  });
});

describe('NN-08 scripts/sandbox/down.ts never deletes outside the sandbox root', () => {
  // A sentinel next to the root: what `--name ../<sentinel>` would delete if the name check let it through.
  const canMakeSentinel = process.platform === 'darwin' && existsSync('/private/tmp');
  const sentinelName = `oa-down-sentinel-${process.pid}`;
  const sentinel = join(SANDBOX_ROOT, '..', sentinelName);

  test('refuses names that escape the root', () => {
    if (canMakeSentinel) {
      mkdirSync(sentinel, { recursive: true });
      scratch.push(sentinel);
    }
    for (const name of [`../${sentinelName}`, '../x', '..', '../../etc', 'a/../../b', '/etc', '']) {
      const r = run(DOWN, freshHome(), ['--name', name]);
      expect({ name, refused: r.code !== 0 }).toEqual({ name, refused: true });
      expect(r.out).not.toContain('stopped and removed');
    }
    if (canMakeSentinel) expect(existsSync(sentinel)).toBe(true);
  });
});
