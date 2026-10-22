#!/usr/bin/env bun
/** Stop a sandbox started by scripts/sandbox/up.ts and delete its throwaway HOME. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/private/tmp/claude-501/wilson-sandbox';
const i = process.argv.indexOf('--name');
const name = i >= 0 ? process.argv[i + 1] : 'default';
if (!/^[\w-]+$/.test(name)) throw new Error(`bad --name ${name}`);
const home = join(ROOT, name);
const file = join(home, 'sandbox.json');
if (existsSync(file)) {
  const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let n = 0; n < 40; n++) { try { process.kill(pid, 0); await Bun.sleep(100); } catch { break; } }
  try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
}
if (!home.startsWith(`${ROOT}/`)) throw new Error('refusing to delete outside the sandbox root');
rmSync(home, { recursive: true, force: true });
console.log(`Sandbox "${name}" stopped and removed.`);
