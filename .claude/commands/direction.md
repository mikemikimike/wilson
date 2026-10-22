---
description: Drift audit. Check whether the implementation still matches the specs (specs/issue-*.md, specs/DECISIONS.md, CLAUDE.md non-negotiables) or is drifting off course
argument-hint: "[all | 84 94 | issue-71_dashboard-import-endpoint | changed]"
allowed-tools: Read, Grep, Glob, Agent, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git merge-base:*), Bash(git branch:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(ls:*), Bash(find:*), Bash(wc:*)
---

# /direction: is the build still on course?

You are auditing Wilson (Bun + TS CLI and dashboard) against its plan. **Read only. Do not edit any file**, in `src/`, `specs/` or elsewhere. Report, with evidence, where the code matches the plan, where it drifted, and what to do about each drift.

Scope from arguments: `$ARGUMENTS`
- empty or `all`: every spec in `specs/` whose issue is closed or whose branch is merged, plus a scan for unplanned work
- one or more spec names or issue numbers (e.g. `84 94`, `issue-71_dashboard-import-endpoint`): only those specs, plus unplanned work touching their files
- `changed`: only files changed since the merge-base with `release/0.10.0` (`git diff $(git merge-base HEAD release/0.10.0)`, plus `git status`), checked against the specs those files belong to

## 1. Load the plan

Wilson has no PRD and no FR IDs. The plan is four sources, in this precedence order:

1. `CLAUDE.md` "MUST NOT TRADE OFF" table (NN-01..NN-10). Violating one is always 🔴.
2. `specs/DECISIONS.md`: binding decisions by Jd. Any row marked `NO`, `OUT`, `DROP` (or "Out of scope") is a **non-goal**; `YES` rows are commitments. Note the round and date of each.
3. `specs/webmcp-threat-model.md` §8: the nine security invariants. Each must stay backed by a test.
4. `specs/*.md` feature specs (`issue-<n>_*.md`, `browser-subagent*.md`, `webmcp-*.md`, `open-jev-labeler.md`). Skip files starting with `_` (templates) and anything under `specs/eval/`.

Requirements have no IDs, so identify each as `<spec-file>#<section>.<n>`, where `<n>` is the ordinal of the bullet, numbered item, test or criterion in that section (e.g. `issue-84_review-queue-guardrail.md#Non-negotiables.2`). Use the spec's own numbering when it has one (Test 7, Verification step 3). When a section has lettered subsections (issue-84 and issue-94 "Tests" a/b/c or A/B/C), put the letter in the ID (`issue-94_...md#Tests.A.3`). When numbering runs on across subheadings (issue-71 tests 1-19), use the continuous number. A spec with no `## Non-negotiables` section (issue-84, issue-71) has none to check: say so, and treat its `## Design decisions`, `## Changes by file` and `## Out of scope` as the binding parts. Cite `Design decisions` by the spec's number.

If `specs/DECISIONS.md` has no row naming an in-scope issue (true for 71, 84, 94 today), say so in the report rather than inventing one; apply only the NN table and threat model.

For each in-scope spec extract: `# Plan:` goal, `## Design decisions`, `## Non-negotiables`, `## Tests`, `## Verification`, `## Acceptance criteria` and any "Acceptance criteria → coverage map" (issue-71 is the model: criterion → covering tests), exact limits, messages, routes, table/column names, and files named.

### Status of a spec
Decide whether a spec is Shipped, In flight or Planned. Read-only evidence only:
- `gh pr list --search "<n>" --state all` first. Squash-merge titles often omit the issue number (`--grep "#84"` and `--grep "#71"` find nothing), and the number in a title can be the PR number (`... (#100)`), not the issue. Ignore search hits for other issues that merely contain the digits (e.g. dependabot `openai-4.0.71`).
- `git log --oneline --all -- <files named in spec>`, `git log --oneline --all --grep "#<n>"`, and, as the reliable fallback, `git log --oneline --all -S"<distinctive symbol, table or route from the spec>"` (e.g. `categorization_reviews`, `apiImport`)
- `git branch -a --list "*<n>*"`; whether that branch is merged into `release/0.10.0` or `main`
- `gh issue view <n> --json state,title` and `gh pr list --search "<n>" --state all --json number,state,mergedAt,headRefName` if `gh` works (if not authenticated or offline, say so and rely on git)
Closed issue / merged branch = **Shipped** (full audit), even if the spec file still says "branch for issue #n" or names a `/home/...` worktree path. Open with a branch = **In flight** (audit what exists, do not flag ❌ for unbuilt parts; mark them "not yet"). No branch = **Planned** (only look for ⏩ pulled-forward work).

## 2. Inventory the implementation

Build a picture of what exists before judging:
- HTTP routes in the dashboard server and which check `canWrite` / auth; WebMCP and `/mcp` tool registrations
- Every tool in the registry, and which are in `TOOLS_REQUIRING_APPROVAL` or the approval gate
- Schema: migrations (`categorization_reviews` and others), tables, columns, per-profile SQLCipher DB handling
- Outbound HTTP calls and `fetch` targets, env vars, new dependencies in `package.json`
- Importers (sign convention), embeddings/provider routing
- User-facing copy the specs quote; `README.md`, `CLAUDE.md` and docs claims
- Tests under `src/__tests__/` that the specs and NN table name

For a scope of 3 specs or fewer, audit inline; do not spawn agents. For `all` with many specs, fan out: launch Explore agents in parallel, one per 2-3 specs, each given the spec text path, its DECISIONS rows and the relevant NN rows, and told to return a per-requirement verdict with `file:line` evidence and "Not verified" items. Keep step 3B (unplanned work) and 3C (cross-cutting) for yourself.

## 3. Compare

### A. Planned → built (coverage and fidelity)
For every in-scope requirement assign one verdict:

| Verdict | Meaning |
|---|---|
| ✅ Aligned | Behaviour matches the spec, including limits, messages and rules |
| 🟡 Partial | Implemented but a detail differs (a limit, a message, an edge case, a missing test the spec lists) |
| ❌ Missing | Required by a Shipped spec but not in the code |
| 🔀 Contradicted | Code does something the spec or a DECISIONS row rules out |

Verify, don't assume: a function with the right name is not evidence. **Reachability counts.** For anything user-facing (a tab, button, route, UI section), confirm it is actually wired in: the component is imported and rendered from the app entry (`src/dashboard/ui/src/App.tsx`), the route is registered in `src/dashboard/server.ts`, the tab id is in `TAB_IDS`. A component that exists but nothing imports is not built. If a file is orphaned, find out why with `git log --oneline -S"<ComponentName>" -- <app entry>` (a deliberate removal is a decision made in a commit, not drift in the code); then the verdict is ❌ Missing for the user-facing requirement (🟡 if the server side and tests are intact), the recommendation is **Decide**, and the missing record goes under Doc drift (DECISIONS lacks the row).

Migration numbers, line numbers, function signatures (sync vs async, return types) and file counts in a spec drift as the code evolves. Match by name and behaviour, not by number: a requirement met under migration v24 instead of v23 is ✅ with a 🧹 doc note, not 🟡. Only a changed *behaviour* is 🟡/🔀. When a later threat-model hardening intentionally changes a spec'd detail (e.g. T10 moved the bank description out of the operation `summary`), that is 🟡 with **Update spec**, citing the threat-model row. Check thresholds, authorization checks, migrations, response codes and approval-gate wiring against the spec's exact values. Where a spec has an acceptance-criteria coverage map (or a numbered test list like issue-71's), confirm every named test exists, by `ls src/__tests__/<file>` and by reading the test body, and asserts the criterion (a test that was later edited to assert the opposite is evidence of an intentional change: see above); a mapped test that is missing or vacuous is 🟡 (❌ if it is the only coverage of a Non-negotiable).

### B. Built → planned (unplanned work)
"Touching their files" means: files the in-scope specs name, plus the files in `git log --oneline --all -- <those files>` since the spec's merge commit. Anything there that no Shipped or In-flight spec (any spec, not only the in-scope ones) explains is unplanned. Later specs that extend an in-scope spec's files (issue-86 resolving the issue-84 queue, issue-63 embed-on-write inside `apiImport`) make that work 🧹 Supporting, named with the spec. Find code no Shipped or In-flight spec explains and classify:

| Class | Meaning |
|---|---|
| ⏩ Pulled forward | Implements a **Planned** spec or a deferred DECISIONS item ahead of its time (name it) |
| ➕ Unplanned | No spec or decision covers it |
| ⛔ Non-goal breach | Builds something DECISIONS marks `NO` / `OUT` / `DROP` (cite the row, e.g. "Q4 open-jev in chat: OUT of v1", "OQ9 bulk confirm: NO", "Q10 local turns to cloud: NO"), or something a spec's Non-goals / "out of scope" section excludes |
| 🧹 Supporting | Infrastructure or refactor that serves existing specs (not drift) |

### C. Cross-cutting
- **NN-01..NN-10**: check each against the code in scope, and for each NN also `ls` the check file(s) the CLAUDE.md table names. A named check that does not exist is itself a finding: 🟡 if the verify harness (`scripts/verify/`, `bun run verify`) is not landed yet (say so), 🔴 once it is landed or if the rule is touched by in-scope code and no other test covers it. Never mark an NN ✅ on the strength of a test file you did not open. Mark an NN "n/a" only when nothing in scope can reach it. Egress (any new `fetch`/URL not localhost or user-configured), telemetry default-off, approval gate on every mutating path, `canWrite` on every mutating route, localhost-only Host/Origin gates, untrusted content inert (no remote images, links as text), amount sign convention, tests never touching real HOME/keychain, no fake data shown as real, speed budget (flag only if evidence exists; do not run anything).
- **Threat-model §8**: for each of the nine invariants touched by the in-scope code (for `changed`, the diff; otherwise the files the in-scope specs name), confirm a backing test still exists and was not weakened.
- **Data**: per-profile SQLCipher DB use; migrations versioned and sequential; no plaintext financial data written outside the profile DB, logs, or fixtures.
- **Doc drift**: `CLAUDE.md`, specs, DECISIONS, README and code disagreeing (stale line numbers, migration numbers and sync/async signatures in specs are 🧹, not drift, unless the behaviour changed). Also list decisions that exist only in a commit message (e.g. a tab removed on purpose) and CLAUDE.md claims about checks that do not exist.
- **Trust boundaries on inputs**: for each new or in-scope route, note unbounded inputs the spec is silent on (body size, row counts, unvalidated settings that weaken a guardrail such as a threshold of 0). List them as 🟡 with **Decide**, not as a violation, unless an NN is breached.

## 4. Judge the direction

- **🟢 ON COURSE**: no ❌, 🔀 or ⛔; at most minor 🟡; any ⏩ or ➕ is small and documented.
- **🟡 DRIFTING**: some 🟡, ❌ or 🔀 in non-NN areas, or meaningful ⏩ / ➕ work the specs don't mention.
- **🔴 OFF COURSE**: any ⛔ non-goal breach, any NN violation, any ❌ or 🔀 on a Non-negotiable, a threat-model §8 invariant lacking a test, or unplanned work larger than the planned work in scope.

## 5. Report

Lead with the verdict. Every finding cites `path:line`. Requirements are cited as `<spec-file>#<section>.<n>`.

```
## Direction: 🟢/🟡/🔴 <VERDICT>

<two or three sentences: what the plan says Wilson is, what the code is becoming, and the single biggest reason for the verdict>

### Scope and status
| Spec | Issue | Status (Shipped / In flight / Planned) | Evidence (branch, PR, issue state) |

### Scorecard
| Spec | Title | ✅ | 🟡 | ❌ | 🔀 | Notes |
|------|-------|----|----|----|----|-------|

### NN and threat-model check
| Item | Result | Evidence |
(NN-01..NN-10 and §8 invariants 1-9 that are in scope)

### Drift, most severe first
1. **<short title>** · <🔀/❌/⛔/⏩/➕/🟡> · `<spec-file>#<section>.<n>` or NN-xx or DECISIONS <row> · `path:line`
   Plan says: <quote or paraphrase with source>
   Code does: <what actually happens>
   Recommendation: **Fix code** | **Update spec** | **Decide** - <one line why>

### Unplanned work
| What | Where | Class | Closest spec/decision | Suggested action |

### Doc drift
- <inconsistencies>

### Next steps
<3 to 5 ordered actions>

### Not verified
<anything you could not confirm, e.g. gh unauthenticated, behaviour needing a running sandbox>
```

Rules for recommendations:
- **Fix code** when the spec is clearly right: any NN, threat-model invariant, approval/authz, data integrity, or a DECISIONS row by Jd.
- **Update spec** when the code is a sensible evolution and the spec is stale. Note that DECISIONS rows by Jd are never updated by an agent; changing one is a **Decide**.
- **Decide** when it is a product call, especially any ⏩ or ⛔, or when two sources conflict. Name the trade-off in one line and leave the choice to Jd.
- A row marked "default" in DECISIONS (orchestrator default) is weaker than one marked "Jd"; say which when citing.
- Never call something aligned without having read the code for it. Unverifiable items go under "Not verified".
