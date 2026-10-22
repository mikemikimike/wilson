// Thin wrapper over the PINNED agent-browser in e2e/node_modules (never the global one on PATH).
// Every call runs in one dedicated session + namespace, so the suite never touches another browser.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_BROWSER_VERSION = '0.39.1';
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Resolve the vendored binary and check its version (fails loudly with the fix). */
export function resolveAgentBrowser() {
  const link = path.join(E2E_DIR, 'node_modules', '.bin', 'agent-browser');
  if (!fs.existsSync(link)) throw new Error(`agent-browser not installed. Run: (cd e2e && npm install)`);
  return link;
}

export class AgentBrowser {
  constructor({ session = 'wilson-e2e', namespace = 'wilson-e2e', headed = false, chrome = process.env.E2E_CHROME, configPath } = {}) {
    this.bin = resolveAgentBrowser();
    this.session = session;
    this.namespace = namespace;
    this.headed = headed;
    this.configPath = configPath;
    // WebMCP (document.modelContext) needs a recent Chrome. The bundled Chrome for Testing can lag; prefer system Chrome.
    const exe = chrome || (fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined);
    this.env = { ...process.env, ...(exe ? { AGENT_BROWSER_EXECUTABLE_PATH: exe } : {}) };
    this.log = []; // every command, for debugging (argv + ms + ok)
  }

  baseArgs() {
    const a = ['--session', this.session, '--namespace', this.namespace];
    if (this.headed) a.push('--headed');
    if (this.configPath) a.push('--config', this.configPath);
    return a;
  }

  /** Run one command. Returns { ok, stdout, stderr, json } (json when `json: true`). Never throws unless `check`. */
  run(args, { json = false, timeout = 60_000, input, check = false } = {}) {
    const argv = [...this.baseArgs(), ...(json ? ['--json'] : []), ...args];
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, argv, { env: this.env, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        let parsed = null;
        if (json) {
          try { parsed = JSON.parse(stdout); } catch { /* not json */ }
        }
        const ok = !err && (!json || parsed?.success !== false);
        const res = { ok, stdout: String(stdout), stderr: String(stderr), json: parsed, error: err ? String(err.message || err) : parsed?.error ?? null };
        this.log.push({ args, ms: Date.now() - t0, ok });
        if (this.log.length > 2000) this.log.shift();
        if (check && !ok) reject(new Error(`agent-browser ${args.join(' ')} failed: ${(res.error || res.stderr || res.stdout).toString().slice(0, 400)}`));
        else resolve(res);
      });
      if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    });
  }

  /** Run and require success. */
  async must(args, opts = {}) { return this.run(args, { ...opts, check: true }); }

  /** Evaluate JS in the page (via stdin, so no shell escaping) and return the parsed result. */
  async eval(js, { timeout = 30_000 } = {}) {
    const r = await this.run(['eval', '--stdin'], { json: true, input: js, timeout });
    if (!r.ok) throw new Error(`eval failed: ${String(r.error || r.stderr).slice(0, 400)}`);
    return r.json?.data?.result;
  }

  data(r) { return r.json?.data; }
}
