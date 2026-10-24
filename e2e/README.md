# e2e: Wilson critical-path browser suite

One command drives the real dashboard through every critical journey with [agent-browser](https://agent-browser.dev)
(not Playwright), records each journey, samples page performance against the NN-10 speed targets, and inventories the
WebMCP tool surface per tab.

```bash
(cd e2e && npm install)      # once: installs agent-browser 0.39.1, pinned (never the global one)
bun run e2e                  # = node e2e/critical-paths.mjs
node e2e/reel/build.mjs      # optional: results + recordings -> e2e/results/reel.mp4 (HyperFrames)
```

Needs: Bun, Node >= 22 (global `WebSocket` for the CDP throttle), Google Chrome (system Chrome is preferred because
WebMCP needs a recent build; Chrome 156 is what this was written against), ffmpeg with libvpx and libx264 for recording.
If `src/dashboard/ui/dist` is missing: `cd src/dashboard/ui && npm ci && bun run build`.

## Isolation

- The suite starts its own sandbox (`bun run sandbox:up --auth --name e2e`: throwaway HOME under
  `/private/tmp/claude-501/wilson-sandbox/e2e`, FAKE seed from `scripts/webmcp-live-seed.ts`, demo-only admin and viewer
  logins, keychain shim) and always runs `sandbox:down` on exit, failure and Ctrl-C. Your real `~/.openaccountant` and
  keychain are never touched (NN-08).
- If a sandbox named `e2e` already exists the suite refuses to start: run `bun run sandbox:down --name e2e`.
- agent-browser runs in its own `--session wilson-e2e-<pid>` and `--namespace wilson-e2e`, with an empty config file, so
  it never attaches to another browser.

## Environment

| Var | Default | What it does |
|---|---|---|
| `E2E_SAMPLES` | `3` | Page loads per tab per viewport for the perf sample. |
| `E2E_RECORD` | `1` | `0` disables the per-path `.webm` recordings. |
| `E2E_PERF` | `1` | `0` skips the perf phase (paths only, ~3 min faster than the default). |
| `E2E_THROTTLE` | `1` | `0` samples the phone viewport unthrottled instead of `mobile4g`. |
| `E2E_ONLY` | all | Comma list of path ids (`P05,P11`); P01 and declared prerequisites are added automatically. |
| `E2E_HEADED` | `0` | `1` shows the browser. |
| `E2E_KEEP` | `0` | `1` leaves the sandbox running after the run (stop it with `sandbox:down --name e2e`). |
| `E2E_CHROME` | system Chrome | Path to the Chrome binary agent-browser launches. |
| `E2E_SANDBOX_NAME` | `e2e` | Sandbox name (keep the default unless two runs must coexist). |

## Output

`e2e/results/` (gitignored):

- `latest.json`: `summary` (passed / failed / skipped, NN-10 verdicts, error counts), `paths[]` (steps with ms,
  status, error, notes, 4xx seen), `perf` (per tab and overall p50/p75/p95 of TTFB, FCP, LCP, CLS for desktop
  1280x900 and phone 390x844 `mobile4g`; horizontal-overflow report at 360 px), `mutations` (each timed human write
  and p50/p95/max), `errors` (console errors, page errors, HTTP 5xx, server-log errors, each tagged with its path),
  `webmcp` (catalog, tools registered per tab, what was invoked with what outcome), and
  `coverage: { tabs: { tab: [pathIds] }, webmcpTools: { name: exercised? } }`.
- `video/<ID>.webm` per path (`E2E_RECORD=0` to skip), `<ID>-fail.png` for a failed path.
- `reel.mp4` after `node e2e/reel/build.mjs`.

Exit code 1 when any path fails. Perf misses are reported (summary.nn10), not failures, so a slow build does not hide a
broken journey.

### How things are measured

- **Mutation round-trip**: in the page, from the trusted `pointerdown` of the click that starts the write to the first
  DOM state that shows its confirmation (a MutationObserver checks the condition on every change). CLI overhead is
  excluded. Writes timed: import, review confirm and correct, set budget, update goal, grant and revoke a tool, mint
  and revoke a client token, kill switch off and on.
- **Page load**: each sample is a full load (`about:blank`, then `<base>/#<tab>`), waits for the tab's own copy, then
  reads navigation timing (TTFB), paint timing (FCP) and buffered `PerformanceObserver`s (LCP, layout shifts).
- **mobile4g**: agent-browser has no CPU or network throttle command, so the suite opens a second CDP client on the
  session's page target (`agent-browser get cdp-url`) and applies Lighthouse's Slow 4G profile: 150 ms RTT, 1.6 Mbps
  down, 750 Kbps up, 4x CPU.
- **360 px**: page-level horizontal scroll per tab (the NN-10 check) plus a list of elements that overflow the viewport
  (reported only), and the **layout audit** (`LAYOUT_AUDIT_JS` in `lib/page.mjs`, 360x800, every tab, fails NN-10 as
  `summary.nn10.layoutAt360` with `offenders` per tab in `latest.json`): (a) `offscreen`, right edge past the viewport
  outside an ancestor that opts into horizontal scrolling (class `overflow-x-auto|scroll` / `overflow-auto|scroll`, inline `overflow-x`, or `data-hscroll`; a plain `overflow-y-auto` tab body does not count, because CSS computes its overflow-x to `auto`, which hid every tab-content overflow before). Calibrate with `node e2e/lib/layout-audit.calibrate.mjs`; (b) `clipped`, `overflow-x: hidden|clip` with `scrollWidth >
  clientWidth + 1` on an element with text (includes ellipsis truncation); (c) `narrowtext`, a text block under 120 px
  wide wrapping to more than 4 lines; (d) `smalltarget`, an interactive element under 24x24 px (inline links in running
  text and 1 px visually-hidden controls are exempt). Added after issue #180: the old check passed while Overview was
  squeezed because the app root clips instead of scrolling.

## Paths

| ID | Journey | Tab | Covers |
|---|---|---|---|
| P01 | Admin signs in through the login gate | overview | AuthGate, NN-04 |
| P02 | Viewer signs in: no Confirm/Apply in Review, no budget/goal forms, the import entry disabled as "Import (admin only)" with an ask-your-admin tooltip, no row editors, kill switch disabled; direct PATCH/DELETE/PUT writes get 403 and change nothing; admin signs back in | settings, review, goals, transactions | NN-04, write-route authz |
| P03 | Overview shows all ten cards with real figures (no NaN/undefined) | overview | OverviewTab, issue 76/80 |
| P04 | Transactions: search narrows the list, category filter, edit a category (the agent proposal + hold-to-approve card; a human admin can also pick one inline, #184), delete (skipped: no delete control exists) | transactions, settings | TransactionsTab, NN-03, NN-07 |
| P05 | Import a FAKE 3-row CSV via the Import dialog: preview, import, rows appear, signs correct | transactions | ImportStatementDialog, issue 71/72, NN-07 |
| P06 | Review: confirm one suggestion, correct another; pending count drops | review | ReviewTab, issue 84/86 |
| P07 | Goals: set a monthly budget, edit a goal's target | goals | GoalsTab |
| P08 | Forecast: fan chart renders; the real-return what-if changes the median; Reset restores | forecast | ForecastTab, issue 42/81 |
| P09 | Accounts: totals and list (or empty state) render | accounts | AccountsTab |
| P10 | Settings -> Agent access: grant a tool and revoke it, mint a client token (shown once) and revoke it, kill switch off (asks first; WebMCP list empties) and on (grants do not come back) | settings | AgentAccessCenter, ClientTokensPanel, KillSwitch, NN-04 |
| P11 | WebMCP surface: grant every tool, `webmcp list` on every tab (the inventory), every read tool answers without a card, every page tool has its visible effect, every change tool raises the approval card and changes nothing when rejected (imperative tools on invoke; declarative forms only after a person submits), `propose_judgments` is refused and nothing is proposed | all | webmcp-bridge, threat model, NN-03, NN-04, NN-06 |
| P12 | LLM: traces, Training lists the seeded interactions, Judge queue | llm | LlmTab, judge |
| P13 | Chat: `/help` answers with no model; a model-backed question is skipped (needs a cloud key or local model, which the suite never adds) | chat | ChatTab, NN-01 |
| P14 | Logs: entries listed, Error filter | logs | LogsTab |

A path whose prerequisite failed (`needs`) is marked **skipped**, not failed. Each path after P01 starts from a fresh
load of Overview.

## Harness notes (agent-browser 0.39.1, headless Chrome 156)

- `fill <sel> ''` empties an input without an input event; React keeps the old value. Clear with Backspace
  (`clearInput` in `lib/page.mjs`).
- Pressing `Escape` flips `document.visibilityState` to `hidden` for the rest of the session. The bridge draws no
  approval cards in a hidden tab, so the suite closes dialogs with their x button instead.
- `webmcp result` cancels the invocation when its timeout passes; always pass `--timeout`.
- Clicks scroll the target into view first and wait for the scroll to settle (`click` in `lib/page.mjs`).
- Grant creation is capped at 20 per minute per user (`src/mcp/rate-limit.ts`); granting all tools waits and retries.

## Reel

`node e2e/reel/build.mjs [--results e2e/results] [--out e2e/results/reel.mp4] [--clip-max 8] [--no-render]` builds a
HyperFrames composition in `e2e/reel/build/` (title card with pass/fail/skip and the NN-10 numbers, one segment per
path with an ID / name / result lower-third, a closing coverage card) and renders it with the pinned
`npx --yes hyperframes@0.8.123 render`. Clips longer than `--clip-max` seconds are sped up with ffmpeg first and
labelled with their speed. `--no-render` writes the composition only (preview it with
`cd e2e/reel/build && npx --yes hyperframes@0.8.123 preview`).
