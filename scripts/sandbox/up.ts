#!/usr/bin/env bun
/**
 * Start a THROWAWAY Wilson dashboard for agents (breaker, pathrunner, /prove) and the verify gate.
 *
 *   bun run sandbox:up [--auth] [--port N] [--name NAME]
 *   bun run sandbox:down [--name NAME]
 *
 * Creates HOME=/private/tmp/claude-501/wilson-sandbox/<name>, seeds it with scripts/webmcp-live-seed.ts (obviously fake
 * rows), optionally turns auth on with demo-only users (scripts/sandbox/users.ts), starts the dashboard on a free port
 * with the keychain shim first on PATH, waits until it answers, and writes <home>/sandbox.json:
 *   { name, home, port, base, pid, auth, users?, log }
 * Your real ~/.openaccountant and login keychain are never touched: the seed guard refuses any HOME outside
 * /private/tmp, and the `security` shim makes the app fall back to plaintext SQLite.
 */
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SANDBOX_USERS } from './users.js';

const ROOT = '/private/tmp/claude-501/wilson-sandbox';
const repo = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const name = opt('name') ?? 'default';
if (!/^[\w-]+$/.test(name)) throw new Error(`bad --name ${name}`);
const home = join(ROOT, name);
const auth = flag('auth');

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port; s.stop(true); return p;
}

if (existsSync(join(home, 'sandbox.json'))) {
  console.error(`Sandbox "${name}" exists at ${home}. Run: bun run sandbox:down --name ${name}`);
  process.exit(1);
}
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const shimDir = join(home, '.webmcp-live-bin');
const env = { ...process.env, HOME: home, PATH: `${shimDir}:${process.env.PATH ?? ''}` };

const run = (script: string) => {
  const r = Bun.spawnSync(['bun', 'run', script], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    console.error(r.stdout.toString(), r.stderr.toString());
    throw new Error(`${script} failed (exit ${r.exitCode})`);
  }
};
run('scripts/webmcp-live-seed.ts');
if (auth) run('scripts/sandbox/enable-auth.ts');

const port = Number(opt('port') ?? (await freePort()));
const log = join(home, 'dashboard.log');
const fd = openSync(log, 'a');
const proc = Bun.spawn(['bun', 'run', 'src/index.tsx', '--dashboard', '--port', String(port)], {
  cwd: repo, env, stdout: fd, stderr: fd, stdin: 'ignore',
});
proc.unref();

const base = `http://localhost:${port}`;
const deadline = Date.now() + 60_000;
for (;;) {
  try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch { /* not up yet */ }
  if (proc.exitCode !== null || Date.now() > deadline) {
    console.error(`Dashboard did not come up; see ${log}`);
    try { proc.kill(); } catch { /* */ }
    process.exit(1);
  }
  await Bun.sleep(250);
}

const info = { name, home, port, base, pid: proc.pid, auth, users: auth ? SANDBOX_USERS : undefined, log };
writeFileSync(join(home, 'sandbox.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
process.exit(0);
