---
description: Blind first-time-user test. Starts a throwaway dashboard, sends the first-timer agent in with nothing but a URL, then triages its usability report against the specs
argument-hint: "[fresh|seeded] [admin|viewer]   (default: fresh, auth off)"
allowed-tools: Agent, Bash, Read, Write, Glob, Grep
---

# /first-timer

Arguments: `$ARGUMENTS`

- `fresh` (default): a brand-new install, with no profile, no data and the onboarding path.
- `seeded`: the household from `scripts/webmcp-live-seed.ts`, with obviously fake rows.
- `admin` / `viewer`: turn dashboard auth on and give the visitor the demo login for that role, as if a family member
  had set it up for them. Leave this out for auth off.

You are the **orchestrator**. You can read everything; the first-timer agent can't, and that is the point. Don't tell
it anything about the app beyond the brief below.

Hard rules (CLAUDE.md MUST NOT TRADE OFF):
- NN-08: only the throwaway sandbox named `first-timer`. Never the real `~/.openaccountant`, real profiles or the
  keychain.
- NN-01: nothing leaves the machine. The agent drives only the pinned agent-browser (`e2e/`), with headless Chromium
  on localhost, never your real Chrome.
- Don't edit `src/`, don't commit, and don't open GitHub issues without Jd's OK. Report only.

## 1. Set up

1. Refuse to run if `/private/tmp/claude-501/wilson-sandbox/first-timer/sandbox.json` exists, because another run
   owns it. Report that and stop; don't tear it down.
2. If `e2e/node_modules/.bin/agent-browser` is missing, run `npm ci` in `e2e/`.
3. Reset the visitor's folders:
   - `rm -rf /private/tmp/claude-501/first-timer`
   - `mkdir -p /private/tmp/claude-501/first-timer/{shots,files,downloads}`
   - Copy `e2e/fixtures/fake-statement.csv` to `/private/tmp/claude-501/first-timer/files/FAKE-checking-export.csv`.
4. Start the sandbox: `bun run sandbox:up --name first-timer` plus `--empty` for `fresh`, plus `--auth` for
   `admin` or `viewer`. Take `base` (and `users`) from the JSON it prints.

## 2. Send the visitor in

Spawn the agent with `Agent`, `subagent_type: "first-timer"` and `model: "sonnet"`. The walk is long and
tool-heavy, and Sonnet handles it well. The prompt is exactly this brief and nothing more:

> A friend told you about an app and left it running on your computer at `<base>`. *(admin/viewer only: "They set
> up an account for you: username `<username>`, password `<password>`.")* You also have a file your bank let you
> download: `/private/tmp/claude-501/first-timer/files/FAKE-checking-export.csv`. Use the app the way you would on
> your own. Write your report when you've done what you came to do, or when you'd have given up.

Its PreToolUse hook (`.claude/hooks/first-timer-guard.mjs`) only lets it reach this sandbox's port. If it reports
that the hook blocked something legitimate, record that as a tooling gap; don't loosen the hook in this run.

## 3. Tear down (always, even if the agent failed)

- `e2e/node_modules/.bin/agent-browser --session first-timer close`
- `bun run sandbox:down --name first-timer`

## 4. Triage

Save the agent's report verbatim to `.verify/first-timer/<YYYY-MM-DD>-<mode>/report.md` (this folder is gitignored),
and copy `shots/` and `downloads/` next to it. Then remove `/private/tmp/claude-501/first-timer`.

You can read the code, so for each friction point:
- **Look at the screenshot** to confirm it happened as described.
- **Classify it:**
  - **Bug:** the app contradicts its spec.
  - **UX gap:** the spec is silent, or met but still confusing.
  - **Intended:** a decision in `specs/DECISIONS.md` or an issue plan explains it. Say whether that decision costs
    first-timers more than it should.
  - **Tooling:** caused by the hook or agent-browser, not the app.
- **Map it to a rule:** note any that touch MUST NOT TRADE OFF, especially trust and privacy wording (NN-01), any
  number that looks invented (NN-09), and phone layout (NN-10).
- **Name the place:** give the file, component or copy string to change. Don't change it.

## Output

```
FIRST-TIMER — <mode> — <date>
First impression: <one line>    Goals: <n> completed / <n> struggled / <n> gave up
Report: .verify/first-timer/<date>-<mode>/report.md

| # | Severity | Where | What happened (visitor's words, short) | Class | Rule | Fix location |
|---|----------|-------|----------------------------------------|-------|------|--------------|

Felt good: <bullets>
Couldn't test: <bullets>
Suggested issues (not filed): <title — one line each>
```
