# CLAUDE.md

Guidance for agents working in the Wilson CLI (`@openaccountant/wilson`). Personality and voice live in `SOUL.md`; the
security model lives in `specs/webmcp-threat-model.md`; per-feature plans live in `specs/issue-*.md` and binding
decisions in `specs/DECISIONS.md`.

## Commands

```bash
bun install && (cd src/dashboard/ui && npm ci && bun run build)
bun run typecheck
bun test src/__tests__/<file>.test.ts      # CI runs every file in its own process
bun run verify                              # MUST NOT TRADE OFF gate + coverage map (see below)
bun run sandbox:up [--auth] [--empty] [--name N]  # throwaway dashboard (seeded; --empty = fresh install); prints sandbox.json
bun run sandbox:down [--name N]
bun run e2e                                 # critical-path browser suite (pathrunner)
bun run src/index.tsx --dashboard --port 3141
```

## Layout

- Data: `~/.openaccountant/profiles/<name>/data.db` (SQLCipher; key in the macOS keychain, service `openaccountant`,
  account `db-encryption-<profile>`). `~/.openaccountant/agent-access.json` is global, outside profiles.
- Dashboard: `src/dashboard/server.ts` (Bun.serve, default port 3141, binds 127.0.0.1), UI in `src/dashboard/ui`.
- Agent tools: `src/tools/`, approval gate `src/agent/approval-gate.ts`, MCP engine `src/mcp/engine.ts`.
- Tests: `src/__tests__/`, preload `src/__tests__/preload.ts` fakes HOME and blocks the real keychain.

## Agents and commands for this repo

| Name | What | Writes |
|---|---|---|
| `breaker` agent | Attacks the sandboxed dashboard: races, double-submit, authz bypass, origin probes, bad input, latency | `breaker-report.md` |
| `pathrunner` agent | Runs (or writes) `e2e/critical-paths.mjs` with agent-browser; records each path | `e2e/results/` |
| `first-timer` agent | Blind usability walk as a brand-new visitor (agent-browser only; hook `.claude/hooks/first-timer-guard.mjs` keeps it off the code). Launched by `/first-timer` | report only |
| `/first-timer [fresh\|seeded] [admin\|viewer]` | Starts a sandbox, briefs the first-timer with only a URL, triages its report against the specs | `.verify/first-timer/` |
| `/direction` | Drift audit: code vs `specs/issue-*.md` + `DECISIONS.md` | report only |
| `/prove <claim>` | Fresh agent re-checks a claim from scratch in a sandbox | report only |
| `/security-gate` | Review of the current diff against MUST NOT TRADE OFF (optional local SonarQube pre-pass, `scripts/sonar/`) | report only |

Agents test only throwaway sandboxes (`bun run sandbox:up`), never the real HOME, profiles or keychain.

## MUST NOT TRADE OFF

These win over speed, scope and polish. Every rule names the check that proves it; `bun run verify` runs them all and
fails if any rule has no passing check. If a change can't keep a rule, stop and ask Jd; don't weaken the check.

| ID | Rule | Check |
|---|---|---|
| NN-01 | **Financial data never leaves the machine unless the user chose it.** With no cloud provider, OTel endpoint or sync configured, the app makes no outbound request beyond localhost. Local turns are never sent to a cloud provider (DECISIONS Q10). | `no-egress-invariant.test.ts`, `privacy-validator*.test.ts` |
| NN-02 | **No telemetry by default.** OTel export is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. | `telemetry-default-off.test.ts` |
| NN-03 | **No agent changes data without a human approval.** Every mutating tool call, on every path (TUI, dashboard chat, WebMCP, `/mcp`, orchestration), goes through the approval gate and fails closed with no handler. Low-confidence categorizations are never auto-applied. | `approval-surfaces`, `tool-mutation`, `dashboard-chat-approval`, `mcp-approval*`, `orchestration-approval`, `categorize-tool` tests |
| NN-04 | **Least privilege for people and agents.** Zero agent tools by default; viewers never write; every mutating REST route checks `canWrite` when auth is on; approval needs a real dashboard page (browser proof) and the dwell floor. | `mcp-client-tokens.test.ts`, `write-route-authz-sweep.test.ts`, `mcp-approval-hardening.test.ts` |
| NN-05 | **The dashboard answers only to localhost.** Foreign Host → 421, foreign Origin on a state change → 403, no wildcard CORS, LAN bind refuses without auth. | `dashboard-origin-gate.test.ts`, `prelabel-origin-gate.test.ts` |
| NN-06 | **Untrusted content stays inert.** Chat and history never fetch remote images and render links as text; tool outputs and page-provided WebMCP metadata are untrusted. | `chat-markdown-img.test.ts` |
| NN-07 | **Amounts mean one thing.** Negative = expense, positive = income/credit, for every importer. | `amount-sign-invariant.test.ts` |
| NN-08 | **Tests and agents never touch real data.** Tests run under the preload's fake HOME and keychain shim; sandboxes live under `/private/tmp` and the seed guard refuses anything else. | `preload.ts`, `scripts/webmcp-live-seed-guard.ts`, `sandbox-guard.test.ts` |
| NN-09 | **Never show fake data as real.** No placeholder or invented numbers in user-facing answers (SOUL.md). Seeds and fixtures are labelled FAKE/dummy. | Reviewed by `/security-gate` (not script-checkable) |
| NN-10 | **Speed.** Mutations p95 < 300 ms; LCP p75 < 2000 ms on the `mobile4g` profile; CLS p75 < 0.1; no horizontal scroll at 360 px. *(Pack defaults until Jd sets targets.)* | `bun run e2e` → `e2e/results/latest.json` |

The nine security invariants in `specs/webmcp-threat-model.md` §8 sit under NN-03…NN-06 and each must stay backed by a
test.

## Conventions

- TypeScript, ESM, Bun. Negative amounts = expense.
- Fixtures and seeds are obviously fake (`FAKE … (dummy)`).
- Never push; Jd merges. Squash-merge feature branches; scan branches before any push.
