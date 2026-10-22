import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The first-timer agent (.claude/agents/first-timer.md) must stay blind to the code and harmless: its PreToolUse hook
 * (.claude/hooks/first-timer-guard.mjs) lets Bash drive only the pinned agent-browser on the first-timer sandbox's
 * own port, and lets Read open only its own screenshots and downloads. Runs the hook as Claude Code does: a
 * separate process, the tool call as JSON on stdin, exit 2 = blocked.
 */
const HOOK = resolve(import.meta.dir, '../../.claude/hooks/first-timer-guard.mjs');
const AB = 'e2e/node_modules/.bin/agent-browser --session first-timer';
const FT = '/private/tmp/claude-501/first-timer';
let dir: string;
let sandboxJson: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ft-guard-'));
  sandboxJson = join(dir, 'sandbox.json');
  writeFileSync(sandboxJson, JSON.stringify({ port: 51234 }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hook(tool_name: string, tool_input: Record<string, unknown>, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['node', HOOK], {
    stdin: Buffer.from(JSON.stringify({ tool_name, tool_input })),
    env: { ...process.env, FT_SANDBOX_JSON: sandboxJson, ...env },
    stderr: 'pipe',
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}
const bash = (command: string, env?: Record<string, string>) => hook('Bash', { command }, env).code;

describe('first-timer guard hook', () => {
  setDefaultTimeout(30_000); // each test spawns ~15 hook processes
  test('allows a person\'s browser actions on the sandbox port', () => {
    for (const c of [
      `${AB} open http://localhost:51234`,
      `${AB} open 'http://127.0.0.1:51234/#transactions'`,
      `${AB} snapshot -i`,
      `${AB} click @e12`,
      `${AB} fill @e3 "firsttimer+1@example.com"`,
      `${AB} press Tab`,
      `${AB} set viewport 390 844`,
      `${AB} screenshot ${FT}/shots/01-landing.png`,
      `${AB} upload @e7 ${FT}/files/FAKE-checking-export.csv`,
      `${AB} back`,
      `curl -sI http://localhost:51234/`,
    ]) expect({ c, code: bash(c) }).toEqual({ c, code: 0 });
  });

  test('blocks reading the code, other tools and shell tricks', () => {
    for (const c of [
      'cat CLAUDE.md',
      'ls src',
      'git log',
      `${AB} open http://localhost:51234 && cat specs/DECISIONS.md`,
      `${AB} open http://localhost:51234; ls`,
      `${AB} open $(cat x)`,
      `${AB} open http://localhost:51234 | tee x`,
      `${AB} fill @e3 "a" > /tmp/x`,
      'e2e/node_modules/.bin/agent-browser open http://localhost:51234', // no session
      'e2e/node_modules/.bin/agent-browser --session e2e open http://localhost:51234', // someone else's session
      // Shell expansion after the check: braces, globs, ~, history, comments.
      `${AB} click {@e1,--executable-path=/bin/sh}`,
      `${AB} upload @e7 ${FT}/files/*`,
      `${AB} click @e[1]`,
      `${AB} fill @e3 ~/.ssh/id_rsa`,
      `${AB} click !!`,
      `${AB} click @e1 #comment`,
      `${AB} click =sh`,
      `${AB} click @e1(e:sh:)`,
      `${AB} click ^@e1`,
      `${AB} click @e1#`,
      `${AB} open http://localhost:51234/?a=1`, // unquoted ? must be quoted
      // Quote adjacency: the shell joins these into one word (-x, --headed), so they must not split into harmless parts.
      `${AB} click @e1 "-"x`,
      `${AB} fill @e3 "-"-headed`,
      `${AB} open "http://localhost:51234"@evil.example`,
      // Options smuggled as arguments.
      `${AB} click @e1 -x`,
      `${AB} fill @e3 --headed`,
    ]) expect({ c, code: bash(c) }).toEqual({ c, code: 2 });
    // The same characters are literal inside quotes, and a typed negative amount is fine.
    expect(bash(`${AB} fill @e3 "{a,b} * ~ 50%?"`)).toBe(0);
    expect(bash(`${AB} fill @e3 "-23.45"`)).toBe(0);
    expect(bash(`${AB} open 'http://localhost:51234/?a=1#tx'`)).toBe(0);
    expect(bash(`${AB} click "div.a .. span"`)).toBe(0); // a selector with .. is not a path
  });

  test('blocks agent-browser powers a visitor does not have', () => {
    for (const c of [
      `${AB} eval "document.cookie"`,
      `${AB} network requests`,
      `${AB} cookies get`,
      `${AB} storage local`,
      `${AB} set headers "{}"`,
      `${AB} set credentials a b`,
      `${AB} webmcp list`,
      `${AB} connect 9222`,
      `${AB} batch "eval 1"`,
      `${AB} get html body`,
      `${AB} read http://localhost:51234`,
    ]) expect({ c, code: bash(c) }).toEqual({ c, code: 2 });
  });

  test('only the sandbox port: no other local services, no internet, no file URLs', () => {
    for (const c of [
      `${AB} open http://localhost:11434`, // Ollama
      `${AB} open http://localhost:9000`, // SonarQube
      `${AB} open https://example.com`,
      `${AB} open file:///etc/passwd`,
      'curl -sI http://localhost:9000/',
      'curl -s http://localhost:51234/api/transactions',
    ]) expect({ c, code: bash(c) }).toEqual({ c, code: 2 });
    // No first-timer sandbox running: nothing is reachable.
    expect(bash(`${AB} open http://localhost:51234`, { FT_SANDBOX_JSON: join(dir, 'missing.json') })).toBe(2);
  });

  test('files only under its own first-timer folders, no traversal', () => {
    for (const c of [
      `${AB} screenshot /tmp/x.png`,
      `${AB} screenshot ${FT}/shots/../../../Users/x.png`,
      `${AB} upload @e7 /Users/jdfiscus/.openaccountant/profiles/default/data.db`,
      `${AB} upload @e7 ${FT}/shots/../files/x.csv`,
      `${AB} download @e9 /Users/jdfiscus/Desktop/x.csv`,
      `${AB} upload @e7 ${FT}/files/..`,
      `${AB} download @e9 ${FT}/downloads/.hidden`,
    ]) expect({ c, code: bash(c) }).toEqual({ c, code: 2 });
  });

  test('Read: own screenshots and downloads only; other tools blocked', () => {
    expect(hook('Read', { file_path: `${FT}/shots/01-landing.png` }).code).toBe(0);
    expect(hook('Read', { file_path: `${FT}/downloads/export.csv` }).code).toBe(0);
    for (const p of ['CLAUDE.md', resolve(import.meta.dir, '../dashboard/server.ts'), `${FT}/shots/../../x.png`, `${FT}/files/FAKE.csv`]) {
      expect({ p, code: hook('Read', { file_path: p }).code }).toEqual({ p, code: 2 });
    }
    expect(hook('Grep', { pattern: 'x' }).code).toBe(2);
    const blocked = hook('Bash', { command: 'cat CLAUDE.md' });
    expect(blocked.err).toContain('Blocked:');
  });
});
