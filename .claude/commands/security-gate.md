---
description: Security-debt gate. Reviews a diff through four lenses (security, privacy/egress, approval/authz, honesty), refutes each finding, runs `bun run verify`, and returns PASS / PASS WITH NOTES / BLOCK. Report-only.
argument-hint: "[base-ref | file paths ...]  (default: merge-base with release/0.10.0)"
---

# /security-gate

Run after every feature, before anything is called done. Nothing ships until this passes.
**Report-only: never edit code, never commit, never push, never add API keys.**

Standards: `CLAUDE.md` "MUST NOT TRADE OFF" (NN-01..NN-10), `specs/webmcp-threat-model.md`
(threats T01-T38 in §6, accepted risks §7, invariants §8), `specs/DECISIONS.md`.
Wilson has no `specs/prd.md`; plans are `specs/issue-*.md` ("# Plan:") docs.

Arguments: `$ARGUMENTS`

## Hard rules for you and every subagent

- Never touch `~/.openaccountant`, real profiles, or the macOS keychain (NN-08). If you need a running app, use a
  sandbox: `bun run sandbox:up [--auth] --name sg-<unique>` (writes
  `/private/tmp/claude-501/wilson-sandbox/<name>/sandbox.json`; demo-only creds) and ALWAYS
  `bun run sandbox:down --name sg-<unique>` when done.
- Do not print financial values or tokens into the report; cite `file:line` only.
- Only `.claude/commands/`, `.deepsec/` and the scratchpad may be written to by this command. No edits under `src/`.

## Step 1: Scope

1. `BASE=$(git merge-base HEAD release/0.10.0)` unless `$ARGUMENTS` gives a ref (then use it) or file paths
   (then scope = those files and skip the diff).
2. `git diff --name-status $BASE...HEAD` plus uncommitted work (`git status --porcelain`, `git diff`). Ignore
   `node_modules`, `data/`, `demos/media`, `*.db`, `.env*`, lockfiles (but list lockfile/`package.json` changes: new
   dependencies are a supply-chain note).
3. Classify changed files: routes (`src/dashboard/**` routes), tools (`src/tools/**`), providers/agent loop, importers,
   MCP/WebMCP, UI, specs/docs. Pass the file list and `git diff $BASE...HEAD` to every lens agent.
4. Empty scope: report "nothing to gate" and still run Step 4.

## Step 2: DeepSec (optional pre-pass; skip silently unless enabled)

DeepSec (npm `deepsec`, vercel-labs/deepsec, pinned 2.3.10) is an AI scanner. **It sends source code to a model
provider**, so it is opt-in and never runs by default. Egress facts (from the 2.3.10 package, `dist/cli.mjs`):

- Default model route is Vercel AI Gateway `https://ai-gateway.vercel.sh` (cli.mjs:73524, 73598-73600); direct routes call
  `api.anthropic.com` / `api.openai.com` (cli.mjs:73528, 73532, 82969-82970). Vercel API is also contacted for OIDC
  token refresh (cli.mjs:4166).
- `init` always links `.deepsec/` to a Vercel project and requires a Vercel login or token (docs/vercel-setup.md).
  There is no local-model (Ollama) route; the only non-vendor option is a custom HTTPS provider (Pi backend).
- Optional `sandbox` commands tar the working tree and upload it to Vercel Sandbox (cli.mjs:83020). Do not use them.
- It behaves as a coding agent with shell access on the host. No telemetry/analytics client was found in cli.mjs.

Run only if ALL are true: `.deepsec/` exists AND `DEEPSEC_ENABLED=1` is set in the environment AND a model key is
already configured by Jd (name the env var, never print its value). Otherwise write "DeepSec: skipped (not enabled)".

Setup (Jd does this once, not you): `npx deepsec@2.3.10 init` from the repo root creates `.deepsec/` (state, findings,
`deepsec.config.ts`, `.vercel/`, `.env.local`). Gitignore `.deepsec/.env.local`, `.deepsec/.vercel/`,
`.deepsec/data/*/files|runs`; reports under `.deepsec/reports/` are fine to keep once reviewed.
Set `ignorePaths` in `.deepsec/data/<id>/config.json` to `data/**`, `demos/media/**`, `**/*.db`, `**/.env*`,
`node_modules/**`, `.openaccountant*/**` so no financial or secret material is uploaded.

Scan (diff only, to bound cost and egress), from `.deepsec/`:

```bash
cd .deepsec
npx deepsec process --diff "$BASE" --max-cost-usd 5   # AI review of changed files only
npx deepsec export --format md-dir --out ./findings
```

Triage each DeepSec finding against the threat model: if it matches a T-number, cite it and mark "known" (not new)
when a §8 invariant test covers it; if it matches a §7 accepted risk, mark "accepted" (not a finding). Everything
left goes into Step 3's refute pass as a candidate.

## Step 3: Parallel review lenses

Launch these four subagents **in one message** (parallel, read-only, model = strongest available; give each the
scope, the diff, and its lens text). Each returns findings as `{severity, file:line, lens, evidence, rule}`; no
finding without a `file:line` that the agent actually read.

1. **Security** - against T01-T38 and the nine §8 invariants. Look for: Host/Origin gate bypasses (NN-05),
   credentials in URLs/storage/audit/logs (inv. 6), unvalidated tool args (T09), untrusted tool output reaching the
   model or DOM unmarked (T10, T20, T31, NN-06), new routes missing ownership checks (T13), unbounded output/paging
   (T11), SQL built by string concat, path traversal in importers, shell/exec use, new dependencies. For each hit
   name the T-number or say "new threat" and propose the invariant test that would cover it.
2. **Privacy / egress** - NN-01, NN-02. Any new outbound call (`fetch`, `WebSocket`, `Bun.spawn curl`, SDK clients,
   `<img src>`/link prefetch), any new hostname, financial data (amounts, merchants, account ids, transaction text,
   profile names) in logs, errors, audit rows, OTel spans, or prompts; local-model turns that could fall back to a
   cloud provider (DECISIONS Q10); telemetry that is not gated on `OTEL_EXPORTER_OTLP_ENDPOINT`. Check
   `no-egress-invariant.test.ts` still covers the new code path or must be extended.
3. **Approval / authz** - NN-03, NN-04. Any new or changed mutating tool: does it go through prepare -> human card ->
   commit (`engine.callTool`), fail closed with no handler, and never auto-apply low-confidence categorizations?
   Any new mutating REST route: `canWrite` when auth is on, viewer cannot write, kill switch honored, browser proof
   plus dwell floor for approvals. **A new mutating route MUST be registered in the write-route authz sweep test**
   (`src/__tests__/write-route-authz-sweep.test.ts`; if that file is absent on this branch, report that as a BLOCK
   because the sweep is the only proof of NN-04). List every mutating route/tool in the diff and the test that
   covers it; uncovered = BLOCK.
4. **Honesty** - NN-09 (and NN-07). Placeholder, invented or hardcoded numbers shown as real in UI/agent answers;
   fixtures and seeds not labelled `FAKE ... (dummy)`; "demo" data that can render on a real profile; empty states
   that show sample figures; amount sign flipped for any importer. Prompts/SOUL.md changes that invite the model to
   guess figures.

### Adversarial refute pass

For EACH finding (including triaged DeepSec ones) launch a separate skeptic subagent that tries to refute it:
read the cited code, trace callers, look for a gate upstream, check the tests and §7. Verdict per finding:
`CONFIRMED` (could not refute), `DOWNGRADED` (real but lower severity / already contained), or `REFUTED` (drop, but
list the one-line reason). Optionally reproduce against a sandbox (`sandbox:up --auth`, curl localhost with a foreign
`Origin`/`Host`, then `sandbox:down`). Do not run exploits against anything but a sandbox.

## Step 4: Verify

Run `bun run verify` (do not edit the verifier; it lives in `scripts/verify/`). Capture exit code and the per-rule
table (NN-01..NN-10, pass/fail/missing check). A rule with no passing check is a failure, not a skip. If
`scripts/verify/run.ts` does not exist yet, record "verify unavailable" and run `bun run typecheck && bun test`
as the fallback, flagged in the verdict.

## Step 5: Verdict

- **BLOCK**: any CONFIRMED High/Critical finding; any NN rule violated or without a passing check; a mutating
  route/tool in scope without gate or sweep-test coverage; new unexplained outbound host; `bun run verify` failed.
- **PASS WITH NOTES**: only Medium/Low CONFIRMED or DOWNGRADED findings, accepted-risk reaffirmations, or DeepSec
  skipped. List each with an owner-ready fix and a follow-up ticket suggestion.
- **PASS**: no confirmed findings and verify green.

Output format (return it as the final message; do not write a report file):

```
VERDICT: PASS | PASS WITH NOTES | BLOCK
Scope: <BASE sha>..<HEAD sha>, N files (routes a, tools b, ...)
verify: <exit code> - NN-01 ok, NN-02 ok, ... (list failures)
DeepSec: skipped | ran (findings: n new, n known, n accepted)
Findings (most severe first):
 1. [SEV][lens][CONFIRMED|DOWNGRADED] path/to/file.ts:LINE - one line. Rule: NN-xx / Txx. Refute attempt: <what was tried>. Fix: <suggestion>
Refuted (dropped): <id - reason>
Mutating surface map: <route/tool -> gate -> sweep/test>
Not checked: <honest gaps>
```
