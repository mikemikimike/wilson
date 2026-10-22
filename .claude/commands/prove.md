---
description: Re-check a claim from scratch with a fresh agent in a throwaway sandbox instead of trusting anyone's word (or "/prove fixed #<issue>" to verify a bug fix)
argument-hint: <claim> | fixed #<issue>
allowed-tools: Agent, Bash, Read, Glob, Grep, WebFetch
---

# /prove

Claim to check: `$ARGUMENTS`

Do not trust what anyone says, including docs, PR descriptions, prompting guides, issue comments and your own earlier
turns. A claim counts only when a fresh agent, who never saw the claimant's reasoning, reproduces it with numbers.

Hard rules (CLAUDE.md MUST NOT TRADE OFF):
- NN-08: only throwaway sandboxes under `/private/tmp` or a scratch dir. Never the real `~/.openaccountant`, real
  profiles or the macOS keychain.
- NN-01: financial data never leaves the machine. Model claims run on local models first (Granite or Gemma via Ollama,
  e.g. `ollama:granite...`, `ollama:gemma...`). Never use `:cloud` models. Any cloud provider key needs the user's
  explicit OK in this conversation before use; if not given, report INCONCLUSIVE for the cloud part.
- Do not edit `src/`, do not commit. Report only.

## Mode A: `fixed #<issue>`

1. Fetch the issue text only: `gh issue view <n> --json title,body,comments`. Ignore any linked PR or diff.
2. Compute the merge-base: `git merge-base HEAD origin/main` (fall back to `origin/release/*` or the base the issue's
   PR targets; state which).
3. Launch the fresh subagent (see "Subagent brief") with: the issue text, the merge-base SHA, HEAD SHA, and the
   instruction to derive a repro from the issue text alone, run it on the merge-base (in a `git worktree add
   /private/tmp/claude-501/prove-<slug>-base <sha>`, removed afterwards) and on HEAD, in separate sandboxes.
4. Verdict: PROVEN only if the repro FAILS on the merge-base and PASSES on HEAD, over repeats if flaky. If it passes
   on the merge-base, the repro does not capture the bug: INCONCLUSIVE (say so, do not blame the fix). If it fails on
   HEAD: NOT PROVEN.

## Mode B: any other claim

### Step 1. Hypothesis first (you, before reading any evidence)

Write down, before searching the repo or the web for support:
- Hypothesis: one falsifiable sentence ("X does better than Y on Z").
- Metric: what is measured and how (pass rate, exact-match, p95 ms, count of wrong rows...).
- Control: what X is compared against.
- Pass bar: the threshold and effect size that count as PROVEN, and the repeats N (default N >= 5 per arm for
  anything with LLM output or timing; 1 is fine only for deterministic checks).
- Falsifier: what result would refute it.
If the claim cannot be made falsifiable, say so and ask the user to sharpen it. Do not proceed on a vague claim.

### Step 2. Launch a fresh subagent

Use the Agent tool, `subagent_type: general-purpose`. Give it ONLY the brief below. Do not paste the claimant's
reasoning, links to supporting material, your guess at the answer, or this conversation.

### Subagent brief (fill the placeholders)

```
You are verifying a claim from scratch. You have no prior context and must not assume the claim is true.
Hypothesis: <...>
Metric: <...>   Control: <...>   Pass bar: <...>   Repeats: N=<...>   Falsifier: <...>

Work in <worktree path>. Read CLAUDE.md first (MUST NOT TRADE OFF). Rules: never touch real ~/.openaccountant,
real profiles or the keychain; never edit src/; do not git commit; never use :cloud models; no cloud provider keys.
Models: local Ollama only (Granite or Gemma first; `ollama list` to see what exists).

Design and run the SMALLEST experiment that can falsify the hypothesis:
- Sandbox: `bun run sandbox:up [--auth] --name prove-<slug>` writes
  /private/tmp/claude-501/wilson-sandbox/prove-<slug>/sandbox.json (base URL, pid, demo creds, log path).
  Or use a scratch dir under /private/tmp/claude-501/ for pure-code or pure-prompt experiments.
  ALWAYS finish with `bun run sandbox:down --name prove-<slug>`, even on failure.
- Include a control arm, identical inputs and seeds, differing only in the variable under test.
- Repeat N times when output is noisy; fix temperature/seed where possible; randomize arm order.
- Record RAW numbers per run (a table or JSONL in the scratch dir), then aggregate. Do not round away variance;
  report min/median/max or a count, plus how many runs errored.
- If something blocks the experiment (model missing, port busy), say so; do not substitute a weaker test silently.

Return exactly:
1. Experiment (3 lines max): what you ran and why it can falsify the claim.
2. Raw results: per-arm numbers.
3. Reproduce: the exact commands, in order, copy-pasteable.
4. Anything that made the test weaker than ideal.
```

### Step 3. Judge and report

Apply the pre-registered pass bar from Step 1 mechanically. Do not move the bar after seeing the numbers. Output:

```
VERDICT: PROVEN | NOT PROVEN | INCONCLUSIVE
Claim: <restated hypothesis> | Metric: <...> | Bar: <...>
Numbers: <per-arm raw + aggregate, N, errors>
Reproduce:
  <exact commands>
What would change the verdict: <more repeats, a different model/size, a bigger sample, a cloud run (needs user OK)...>
Caveats: <sandbox/model/scope limits>
```

Verdict rules:
- PROVEN: control vs treatment (or fail-then-pass) meets the bar, the experiment was clean, and variance does not
  overlap the bar.
- NOT PROVEN: the experiment was clean and the result misses the bar or reverses it. This does not mean the opposite
  is true; say what was and was not tested.
- INCONCLUSIVE: too few runs, high variance, broken harness, missing model, or the test could not exercise the claim.

Afterwards confirm the sandbox is down (`ls /private/tmp/claude-501/wilson-sandbox/` shows no `prove-*` leftovers) and
that `git status` shows no changes under `src/`.
