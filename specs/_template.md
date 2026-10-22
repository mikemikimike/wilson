# Plan: <one-line outcome, what changes for the user>

**Issue:** #<n> (decomposed from #<parent>, if any)
**Branch:** `<branch>`
**Status:** Planned | In flight | Shipped
**Goal:** <two or three sentences. The observable behaviour when this is done.>

> Audited by `/direction`. Requirements are cited as `<this-file>#<section>.<n>`, so keep sections and numbering stable.
> Files starting with `_` are skipped by `/direction`.

## Problem recap

<What is wrong or missing today, with `path:line` evidence verified during recon.>

## Requirements

Number every requirement. One testable behaviour each; include exact limits, status codes, messages, table/column names.

| ID | Requirement | Source |
|---|---|---|
| R1 | <the system does X when Y; exact values> | <issue / DECISIONS row> |
| R2 | | |

## Design decisions

1. <decision, and why; alternatives rejected>
2.

## Non-negotiables

Reference the CLAUDE.md "MUST NOT TRADE OFF" IDs that this work touches and say how each is honoured. If a threat-model invariant (`specs/webmcp-threat-model.md` §8) is touched, name it.

| ID | How this plan honours it | Backing test |
|---|---|---|
| NN-03 | <e.g. mutating tool goes through approval gate, fails closed> | <test file / test name> |
| NN-04 | | |
| §8 inv. <n> | | |

List NN items that are explicitly not touched: <NN-01, NN-02, ...>.

## Non-goals

Things this plan deliberately does not do. If a DECISIONS row says NO / OUT / DROP, cite it. `/direction` flags code that builds any of these as a non-goal breach.

- <not doing X> (DECISIONS <row>, if applicable)
-

## Tests

Numbered, so the coverage map can cite them. Say which file each lives in under `src/__tests__/`.

1. <test: setup, action, assertion>
2.

## Verification

Commands to run and manual checks (sandbox: `bun run sandbox:up --name <name>` ... `bun run sandbox:down --name <name>`; never real profiles or the real keychain).

1. `bun run typecheck`
2. `bun test <file>`
3. <manual check with expected result>

## Acceptance criteria → coverage map

Every Requirement and every Non-negotiable must appear in at least one row. A row with no test must say how it is verified (Verification step) or why it cannot be scripted.

| Criterion | Requirement / NN | Covered by |
|---|---|---|
| <observable outcome> | R1 | Tests 1-3 |
| <outcome> | NN-03 | Test 4 |
| <outcome> | R2 | Verification step 3 |

## Risks / notes for the builder

- <traps, ordering constraints, things that must stay byte-identical>

## Open questions

Log answers in `specs/DECISIONS.md` (Q-number, decision, `Jd` or `default`). Builders must not act on an unanswered question.

- Q1: <question>
