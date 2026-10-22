// PreToolUse hook for the first-timer agent (.claude/agents/first-timer.md). It keeps the agent blind and harmless:
//   Bash: only the pinned agent-browser on the `first-timer` session, acting like a person in the page (no eval,
//         network, cookies, storage, headers, CDP, WebMCP or batch), only on localhost; plus `curl -sI` to localhost.
//   Read: only the agent's own screenshots and downloads under /private/tmp/claude-501/first-timer/.
// Anything else exits 2 (blocked) with the reason on stderr. Tested by src/__tests__/first-timer-guard.test.ts.
import { existsSync, readFileSync } from 'node:fs';

export const FT_ROOT = '/private/tmp/claude-501/first-timer';
const AB = 'e2e/node_modules/.bin/agent-browser';
const SESSION = 'first-timer';

// Only the first-timer sandbox's own port (scripts/sandbox/up.ts --name first-timer), so other local services
// (Ollama, SonarQube, another sandbox) stay out of reach. FT_SANDBOX_JSON overrides the path for tests.
const SANDBOX_JSON = process.env.FT_SANDBOX_JSON ?? '/private/tmp/claude-501/wilson-sandbox/first-timer/sandbox.json';
function sandboxPort() {
  try { return existsSync(SANDBOX_JSON) ? String(JSON.parse(readFileSync(SANDBOX_JSON, 'utf8')).port) : null; } catch { return null; }
}
const localUrl = (u) => {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?:\/[\w./?=&%#:+-]*)?$/.exec(u);
  return !!m && m[1] === sandboxPort();
};
const file = (dir, ext) => new RegExp(`^${FT_ROOT}/${dir}/[\\w.-]+${ext}$`);
const SHOT = file('shots', '\\.png');
const UPLOAD = file('files', '');
const DOWNLOAD = file('downloads', '');

// Subcommands a person's hands and eyes can do. Each checks its own arguments.
const anyArgs = () => true;
const SUBCOMMANDS = {
  open: (a) => a.length === 1 && localUrl(a[0]),
  click: anyArgs, dblclick: anyArgs, type: anyArgs, fill: anyArgs, press: anyArgs, hover: anyArgs, focus: anyArgs,
  check: anyArgs, uncheck: anyArgs, select: anyArgs, scroll: anyArgs, scrollintoview: anyArgs, wait: anyArgs,
  keyboard: (a) => ['type', 'inserttext'].includes(a[0]),
  snapshot: (a) => a.every((x) => ['-i', '-c', '--interactive', '--compact'].includes(x)),
  screenshot: (a) => a.length === 1 && SHOT.test(a[0]) || (a.length === 2 && a[0] === '--full' && SHOT.test(a[1])),
  upload: (a) => a.length === 2 && UPLOAD.test(a[1]),
  download: (a) => a.length === 2 && DOWNLOAD.test(a[1]),
  back: (a) => a.length === 0, forward: (a) => a.length === 0, reload: (a) => a.length === 0,
  get: (a) => ['text', 'title', 'url', 'value', 'count'].includes(a[0]),
  is: (a) => ['visible', 'enabled', 'checked'].includes(a[0]),
  find: anyArgs,
  set: (a) => (a[0] === 'viewport' && a.length === 3 && a.slice(1).every((n) => /^\d{3,4}$/.test(n)))
    || (a[0] === 'media' && a.slice(1).every((m) => ['dark', 'light', 'reduced-motion'].includes(m))),
  console: (a) => a.length === 0, errors: (a) => a.length === 0,
  close: (a) => a.length === 0,
};

/** Split a command like a shell would for plain words and quoted strings; null if it has anything fancier. */
export function words(cmd) {
  if (/[;&|<>`$\\\n\r]/.test(cmd)) return null;
  const out = [];
  // Each word must end at whitespace or the end: the shell joins `"-"x` into one word `-x`, so adjacency is refused.
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/y;
  let m;
  while (re.lastIndex < cmd.length && (m = re.exec(cmd))) {
    // Unquoted words must not expand into something else after this check: braces, globs, ~, ! history, # comments, zsh =cmd.
    if (m[3] !== undefined && (/[{}*?[\]~!]/.test(m[3]) || /^[#=]/.test(m[3]))) return null;
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return re.lastIndex >= cmd.trimEnd().length ? out : null;
}

/** Returns null when allowed, else the reason it is blocked. */
export function check(tool_name, tool_input) {
  if (tool_name === 'Read') {
    const p = String(tool_input?.file_path ?? '');
    return (SHOT.test(p) || DOWNLOAD.test(p)) && !p.includes('..')
      ? null : `first-timer may only read its own files under ${FT_ROOT}/shots or ${FT_ROOT}/downloads.`;
  }
  if (tool_name !== 'Bash') return `first-timer may not use ${tool_name}.`;
  const cmd = String(tool_input?.command ?? '').trim();
  const w = words(cmd);
  if (!w) return 'no pipes, chaining, redirects, $, backticks, backslashes or newlines.';
  if (w.some((x) => x.includes('..'))) return 'no ".." in arguments.';
  if (w[0] === 'curl') return w.length === 3 && w[1] === '-sI' && localUrl(w[2]) ? null : 'curl: only `curl -sI http://localhost:<sandbox port>/...`.';
  if (w[0] !== AB || w[1] !== '--session' || w[2] !== SESSION) {
    return `only \`${AB} --session ${SESSION} <command> ...\` or \`curl -sI http://localhost:<port>\`.`;
  }
  const [sub, ...args] = w.slice(3);
  const ok = SUBCOMMANDS[sub];
  if (!ok) return `agent-browser "${sub ?? ''}" is not something a first-time visitor does.`;
  // No options smuggled in as arguments (--flag or -x); a typed negative amount like "-23.45" is fine.
  if (sub !== 'snapshot' && sub !== 'screenshot' && args.some((x) => /^--|^-[A-Za-z]/.test(x))) return 'no extra options.';
  return ok(args) ? null : `agent-browser ${sub}: arguments not allowed (${args.join(' ').slice(0, 120)}).`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { tool_name, tool_input } = JSON.parse(readFileSync(0, 'utf8'));
  const why = check(tool_name, tool_input);
  if (why) {
    process.stderr.write(`Blocked: ${why} Don't work around it; if you're stuck, say so in your report.`);
    process.exit(2);
  }
}
