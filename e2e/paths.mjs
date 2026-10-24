// The critical paths. Each path is one user journey: { id, name, tab, covers, needs, run(ctx) }.
// Steps assert on copy the components really render (file references in comments). Later paths depend on earlier
// state through `needs`; a missing dependency skips the path instead of failing it.
import fs from 'node:fs';
import path from 'node:path';
import { clearInput, click, clickText, expectNoText, expectText, gotoTab, q, sleep, tagByText, tagWhere, textOf, timeMutation, waitFor } from './lib/page.mjs';

/**
 * Page-side expression: a transaction row's category. An admin's cell is a <select> (#184), whose innerText lists
 * every option, so read its value; a viewer's cell is plain text.
 */
const CATEGORY_CELL = `((r) => { const c = r?.children[3]; const sel = c?.querySelector('select'); return (sel ? sel.value : c?.innerText ?? '').trim(); })`;

const MAIN = 'main';

// ── shared helpers ───────────────────────────────────────────────────────────

async function login(ctx, who) {
  const { ab } = ctx;
  const user = ctx.sb.users[who];
  await expectText(ab, 'Sign in', { timeout: 20_000 }); // AuthGate.tsx GateCard title
  await ab.must(['fill', 'input[aria-label="Username"]', user.username]);
  await ab.must(['fill', 'input[aria-label="Password"]', user.password]);
  const sel = await tagByText(ab, 'Sign in', { selector: 'button' });
  await click(ab, sel);
  await waitFor(ab, `!!document.querySelector('nav') && [...document.querySelectorAll('nav button')].some((b) => b.innerText.trim() === 'Overview')`, { timeout: 20_000, what: 'dashboard after sign-in' });
}

async function logout(ctx, username) {
  const { ab } = ctx;
  await gotoTab(ab, 'Settings', 'Authentication');
  // SettingsTab.tsx:304 "Logout (<username>)"
  await clickText(ab, `Logout (${username})`, { within: MAIN });
  await expectText(ab, 'Sign in', { timeout: 20_000 });
}

/** Tool row in Settings -> Agent access (ToolPolicyTable.tsx), tagged; returns its selector. */
async function toolRow(ab, name) {
  return tagWhere(ab, '[data-testid="agent-tool-policies"] > div', `e.querySelector('.font-mono')?.textContent === ${q(name)}`, { what: `tool row ${name}` });
}

/**
 * Grant one tool to this tab. The server caps grant creation at 20 per minute per user (LIMIT_GRANTS_POST,
 * src/mcp/rate-limit.ts:39) and the page shows "Too many grant requests — wait a moment."; we wait and retry, as a
 * person would. Returns the click-to-"Granted" ms of the attempt that succeeded, and whether it was rate limited.
 */
async function grantTool(ab, name) {
  const row = await toolRow(ab, name);
  const already = await ab.eval(`document.querySelector(${q(row)}).innerText.includes('Granted')`);
  if (already) return { ms: 0, limited: 0 };
  let limited = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const btn = await tagWhere(ab, `${row} button`, `e.innerText.trim() === 'Grant to this tab' && !e.disabled`, { what: `Grant button for ${name}` });
    try {
      const ms = await timeMutation(ab, `document.querySelector(${q(row)})?.innerText.includes('Granted') || (document.querySelector('[data-testid="agent-access-center"]')?.innerText ?? '').includes('Too many grant requests')`, () => click(ab, btn), { timeout: 8_000 });
      if (await ab.eval(`document.querySelector(${q(row)})?.innerText.includes('Granted')`)) return { ms, limited };
    } catch { /* no answer yet: look again below */ }
    if (await ab.eval(`document.querySelector(${q(row)})?.innerText.includes('Granted')`)) return { ms: null, limited };
    limited++;
    await sleep(3_500); // the bucket refills one grant every 3 s
  }
  throw new Error(`could not grant ${name} (rate limited ${limited}x)`);
}

/** The bridge's floating confirmation card (webmcp-bridge.ts: "Confirm: <Tool>", "Hold to approve", "Reject"). */
const CARD_VISIBLE = `[...document.querySelectorAll('button')].some((b) => ['Hold to approve', 'Hold to allow'].includes(b.innerText.trim()) && b.getBoundingClientRect().width > 0)`;

/** Reject a change card ("Reject") or refuse a read/proposal card ("Don't allow"). */
async function rejectCard(ab) {
  await sleep(300);
  const label = (await ab.eval(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Reject' && b.getBoundingClientRect().width > 0)`)) ? 'Reject' : "Don't allow";
  const sel = await tagByText(ab, label, { selector: 'button', exact: true });
  await click(ab, sel);
}

/** Hold-to-approve needs a trusted pointer held >= 600 ms after the 800 ms arm (HoldToApprove.tsx, confirmation-card.ts). */
async function holdApprove(ab) {
  await sleep(1300); // arm delay (800 ms) + the server refuses approvals younger than 1 s
  const sel = await tagByText(ab, 'Hold to approve', { selector: 'button' });
  const box = await ab.eval(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await ab.must(['mouse', 'move', String(box.x), String(box.y)]);
  await ab.must(['mouse', 'down']);
  await sleep(1100);
  await ab.must(['mouse', 'up']);
}

async function invoke(ab, tool, params, { detach = false, timeout = 20_000 } = {}) {
  const args = ['webmcp', 'invoke', tool, '--params', JSON.stringify(params ?? {}), '--timeout', String(timeout)];
  if (detach) args.push('--detach');
  const r = await ab.run(args, { json: true, timeout: timeout + 10_000 });
  return { ok: r.ok, data: r.json?.data, error: r.json?.error ?? r.error };
}

async function webmcpResult(ab, invocationId, timeout = 15_000) {
  const r = await ab.run(['webmcp', 'result', invocationId, '--timeout', String(timeout)], { json: true, timeout: timeout + 10_000 });
  return { ok: r.ok, data: r.json?.data, error: r.json?.error ?? r.error };
}

async function listTools(ab) {
  const r = await ab.run(['webmcp', 'list'], { json: true });
  if (!r.ok) throw new Error(`webmcp list failed: ${r.error}`);
  return r.json.data.tools ?? [];
}

/** The page context's own count line: TransactionsTab.tsx "<shown> of <total> transactions". */
async function txCount(ab) {
  const t = await textOf(ab, MAIN);
  const m = /(\d+) of (\d+) transactions/.exec(t);
  return m ? { shown: +m[1], total: +m[2] } : null;
}

function fixtureFor(ctx) {
  // FAKE rows with dates inside the current month, so the default (this month) header range shows them.
  const tpl = fs.readFileSync(path.join(ctx.e2eDir, 'fixtures', 'fake-statement.csv'), 'utf8').trim().split('\n');
  const now = new Date();
  const day = (n) => { const d = new Date(now.getFullYear(), now.getMonth(), Math.min(n, now.getDate())); return d.toISOString().slice(0, 10); };
  const rows = tpl.slice(1).map((line, i) => line.replace(/^\d{4}-\d{2}-\d{2}/, day(1 + i)));
  const out = path.join(ctx.resultsDir, 'fixtures', 'fake-statement.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [tpl[0], ...rows].join('\n') + '\n');
  return out;
}

// ── paths ────────────────────────────────────────────────────────────────────

export const PATHS = [
  {
    id: 'P01',
    name: 'Admin signs in',
    tab: 'overview',
    covers: ['AuthGate.tsx', 'NN-04', 'NN-05'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open dashboard (login gate)', async () => {
        await ab.must(['open', ctx.base + '/']);
        await ab.eval(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);
        await ab.must(['open', 'about:blank']);
        await ab.must(['open', ctx.base + '/#overview']);
        await expectText(ab, 'Sign in', { timeout: 20_000 });
      });
      await step('sign in as admin', async () => login(ctx, 'admin'));
      await step('overview is the landing tab', async () => expectText(ab, 'This week', { within: MAIN, timeout: 20_000 }));
      ctx.state.adminSession = true;
    },
  },
  {
    id: 'P02',
    name: 'Viewer is read-only (no write controls, writes refused)',
    tab: 'settings',
    covers: ['NN-04', 'write-route-authz-sweep', 'ReviewTab.tsx:420', 'ImportStatementDialog.tsx:182', 'KillSwitch.tsx'],
    needs: ['P01'],
    async run(ctx) {
      const { ab, step } = ctx;
      ctx.state.adminSession = false;
      try {
        await step('admin logs out', async () => logout(ctx, ctx.sb.users.admin.username));
        await step('sign in as viewer', async () => login(ctx, 'viewer'));
        await step('Review: suggestions are read-only, no Confirm/Apply', async () => {
          await gotoTab(ab, 'Review', 'pending');
          await expectText(ab, 'Suggestions are read-only for your role', { within: MAIN });
          const buttons = await ab.eval(`[...document.querySelectorAll('main button')].map((b) => b.innerText.trim())`);
          if (buttons.includes('Confirm') || buttons.includes('Apply')) throw new Error(`viewer sees write buttons: ${buttons.join(', ')}`);
        });
        await step('Goals: budget and goal forms hidden', async () => {
          await gotoTab(ab, 'Goals', 'Active goals');
          const buttons = await ab.eval(`[...document.querySelectorAll('main button')].map((b) => b.innerText.trim())`);
          if (buttons.includes('Set budget') || buttons.includes('Update goal')) throw new Error(`viewer sees goal write buttons: ${buttons.join(', ')}`);
        });
        await step('Transactions: import is admin-only before any work, and rows have no editors', async () => {
          await gotoTab(ab, 'Transactions', 'transactions');
          // #190: the entry itself says so, disabled, with a tooltip naming what to do next.
          await waitFor(ab, `[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Import (admin only)')?.disabled === true`, { what: 'disabled "Import (admin only)" entry' });
          const tip = await ab.eval(`[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === 'Import (admin only)')?.parentElement?.title ?? ''`);
          if (!/household admin/.test(tip)) throw new Error(`admin-only tooltip missing: ${JSON.stringify(tip)}`);
          // #184/#187: no category/account picker for a viewer (NN-04).
          const pickers = await ab.eval(`document.querySelectorAll('main select[aria-label="Category"], main select[aria-label="Account"], main select[aria-label="Entity"]').length`);
          if (pickers !== 0) throw new Error(`viewer sees ${pickers} row editors`);
        });
        await step('Settings: kill switch is admin-only', async () => {
          await gotoTab(ab, 'Settings', 'Agent access');
          await waitFor(ab, `document.querySelector('button[role="switch"][aria-label="Agent access"]')?.disabled === true`, { what: 'disabled kill switch' });
        });
        await step('direct write attempts are refused (403) and change nothing', async () => {
          const r = await ab.eval(`(async () => {
            const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('wilson_auth_token') };
            const list = await (await fetch('/api/transactions', { headers: h })).json();
            const tx = list.find((t) => /Corner Cafe/.test(t.description));
            const patch = await fetch('/api/transactions/' + tx.id, { method: 'PATCH', headers: h, body: JSON.stringify({ category: 'Travel' }) });
            const del = await fetch('/api/transactions/' + tx.id, { method: 'DELETE', headers: h });
            const budget = await fetch('/api/budgets/Dining', { method: 'PUT', headers: h, body: JSON.stringify({ monthlyLimit: 1 }) });
            const after = (await (await fetch('/api/transactions', { headers: h })).json()).find((t) => t.id === tx.id);
            return { patch: patch.status, del: del.status, budget: budget.status, before: tx.category, after: after && after.category };
          })()`);
          ctx.note(`viewer write statuses: ${JSON.stringify(r)}`);
          if (r.patch !== 403 || r.del !== 403) throw new Error(`expected 403 for PATCH/DELETE, got ${JSON.stringify(r)}`);
          if (r.budget !== 403) throw new Error(`expected 403 for PUT /api/budgets/Dining, got ${r.budget}`);
          if (r.after !== r.before) throw new Error(`transaction changed for a viewer: ${r.before} -> ${r.after}`);
        });
      } finally {
        await step('viewer logs out, admin signs back in', async () => {
          if (await ab.eval(`!!localStorage.getItem('wilson_auth_token')`)) {
            await ab.eval(`(() => { localStorage.removeItem('wilson_auth_token'); return true; })()`);
          }
          await ab.must(['open', 'about:blank']);
          await ab.must(['open', ctx.base + '/#overview']);
          await login(ctx, 'admin');
          ctx.state.adminSession = true;
        });
      }
    },
  },
  {
    id: 'P03',
    name: 'Overview loads its cards',
    tab: 'overview',
    covers: ['OverviewTab.tsx', 'issue-76_offline-overview-cards', 'issue-80_cash-forecast-fan-chart'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open Overview', async () => gotoTab(ab, 'Overview', 'This week'));
      // The savings card is titled 'Savings Rate', or 'Net Savings' when income is too low for a rate (SavingsSparkline).
      for (const card of ['Spending heatmap', 'Streak', 'Budget countdown', ['Savings rate', 'Net savings'], 'Cash forecast', 'Spending by category', 'Profit & loss', 'Budgets vs actual', 'Alerts', 'Net worth']) {
        const titles = [card].flat();
        await step(`card: ${titles.join(' / ')}`, async () =>
          Promise.any(titles.map((t) => expectText(ab, t, { within: MAIN, timeout: 15_000 }))));
      }
      await step('figures come from the seeded FAKE ledger (no NaN / undefined)', async () => {
        const t = await textOf(ab, MAIN);
        if (/\bNaN\b|undefined|\$-?Infinity/.test(t)) throw new Error('Overview shows NaN/undefined/Infinity');
        if (!/Income\s*\n?\s*\$[\d,]+\.\d\d/.test(t)) throw new Error('Profit & loss income figure missing');
      });
    },
  },
  {
    id: 'P04',
    name: 'Transactions: search, filter, edit a category, delete',
    tab: 'transactions',
    covers: ['TransactionsTab.tsx', 'issue-62_dashboard-semantic-search', 'NN-03', 'NN-07'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step, skip } = ctx;
      let total;
      await step('open Transactions', async () => {
        await gotoTab(ab, 'Transactions', 'transactions');
        await waitFor(ab, `document.querySelectorAll('main tbody tr[data-tx-id]').length > 0`, { what: 'transaction rows' });
        total = (await txCount(ab)).total;
      });
      await step('search by merchant', async () => {
        await ab.must(['fill', 'input[placeholder="Search by merchant or description..."]', 'Corner Cafe']);
        await waitFor(ab, `(() => { const rows = [...document.querySelectorAll('main tbody tr[data-tx-id]')]; return rows.length > 0 && rows.every((r) => r.innerText.includes('Corner Cafe')); })()`, { what: 'only Corner Cafe rows' });
        const c = await txCount(ab);
        if (!c || c.shown >= c.total) throw new Error(`search did not narrow the list: ${JSON.stringify(c)}`);
      });
      await step('filter by category', async () => {
        await clearInput(ab, 'input[placeholder="Search by merchant or description..."]');
        await waitFor(ab, `(() => { const m = /(\\d+) of (\\d+) transactions/.exec(document.querySelector('main').innerText); return m && +m[1] === +m[2]; })()`, { what: 'search cleared' });
        await ab.must(['select', 'form[aria-label="Filter transactions"] select[name="category_id"]', 'Groceries']);
        await clickText(ab, 'Apply', { within: 'form[aria-label="Filter transactions"]' });
        await waitFor(ab, `(() => { const rows = [...document.querySelectorAll('main tbody tr[data-tx-id]')]; return rows.length > 0 && rows.every((r) => ${CATEGORY_CELL}(r).includes('Groceries')); })()`, { what: 'only Groceries rows' });
        await ab.must(['select', 'form[aria-label="Filter transactions"] select[name="category_id"]', 'All Categories']);
        await clickText(ab, 'Apply', { within: 'form[aria-label="Filter transactions"]' });
        await waitFor(ab, `(() => { const m = /(\\d+) of (\\d+) transactions/.exec(document.querySelector('main').innerText); return m && +m[1] === +m[2]; })()`, { what: 'filters cleared' });
      });
      // A human admin edits a category inline (#184): the same validated PATCH, no approval card (NN-03 is agents only).
      await step('edit a category by hand (inline picker)', async () => {
        // Not a row the later steps drive (Taco Palace, Corner Cafe); its category is put back afterwards.
        const found = await ab.eval(`(() => { const r = [...document.querySelectorAll('main tbody tr[data-tx-id]')].find((r) => r.querySelector('select[aria-label="Category"]') && !/Taco Palace|Corner Cafe/.test(r.innerText) && ${CATEGORY_CELL}(r) !== '' && ${CATEGORY_CELL}(r) !== 'Dining'); return r ? { id: +r.dataset.txId, cat: ${CATEGORY_CELL}(r) } : null; })()`);
        if (!found) throw new Error('no row with a category picker');
        const sel = `main tbody tr[data-tx-id="${found.id}"] select[aria-label="Category"]`;
        await ab.must(['select', sel, 'Dining']);
        await waitFor(ab, `${CATEGORY_CELL}(document.querySelector('main tbody tr[data-tx-id="${found.id}"]')) === 'Dining'`, { what: `row ${found.id} shows Dining` });
        await waitFor(ab, `document.querySelector('main tbody tr[data-tx-id="${found.id}"]')?.querySelector('[title="Verified by you"]') != null`, { what: `row ${found.id} verified badge` });
        await ab.must(['select', sel, found.cat]);
        await waitFor(ab, `${CATEGORY_CELL}(document.querySelector('main tbody tr[data-tx-id="${found.id}"]')) === ${JSON.stringify(found.cat)}`, { what: `row ${found.id} back to ${found.cat}` });
      });
      // Delete has no control in the Transactions tab. The agent path (`update_transaction`) and the approval card a
      // person must hold to approve is the other way to edit a category, so this step drives it too.
      await step('edit a category (agent proposal + hold-to-approve card)', async () => {
        await gotoTab(ab, 'Settings', 'Agent access');
        await grantTool(ab, 'update_transaction');
        await gotoTab(ab, 'Transactions', 'transactions');
        const target = await ab.eval(`(() => { const r = [...document.querySelectorAll('main tbody tr[data-tx-id]')].find((r) => r.innerText.includes('Taco Palace')); return r ? { id: +r.dataset.txId, cat: ${CATEGORY_CELL}(r) } : null; })()`);
        if (!target) throw new Error('no Taco Palace row to edit');
        const inv = await invoke(ab, 'update_transaction', { id: target.id, category: 'Travel' }, { detach: true });
        if (!inv.ok || !inv.data?.invocationId) throw new Error(`invoke failed: ${inv.error}`);
        await waitFor(ab, CARD_VISIBLE, { what: 'approval card' });
        await expectText(ab, 'Confirm: Update Transaction');
        await holdApprove(ab);
        const res = await webmcpResult(ab, inv.data.invocationId);
        ctx.note(`update_transaction approve result: ${JSON.stringify(res.data?.output ?? res.error)}`);
        if (res.data?.output?.outcome && res.data.output.outcome !== 'committed') throw new Error(`approval outcome ${res.data.output.outcome}`);
        await gotoTab(ab, 'Overview', 'This week');
        await gotoTab(ab, 'Transactions', 'transactions');
        await waitFor(ab, `${CATEGORY_CELL}(document.querySelector('main tbody tr[data-tx-id="${target.id}"]')).includes('Travel')`, { what: `row ${target.id} shows Travel` });
        ctx.state.editedTx = target.id;
      });
      await step('delete a transaction', async () => {
        skip('no delete control exists: TransactionsTab.tsx has no delete button and no WebMCP tool deletes; DELETE /api/transactions/:id (server.ts:792) has no UI caller');
      });
      if (total === undefined) throw new Error('unreachable');
    },
  },
  {
    id: 'P05',
    name: 'Import a CSV statement through the Import dialog',
    tab: 'transactions',
    covers: ['ImportStatementDialog.tsx', 'issue-71_dashboard-import-endpoint', 'issue-72_file-reader-importer-ui', 'NN-07'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      const file = fixtureFor(ctx);
      let before;
      await step('open the Import dialog', async () => {
        await gotoTab(ab, 'Transactions', 'transactions');
        before = await txCount(ab);
        await clickText(ab, 'Import statement', { within: MAIN });
        await expectText(ab, 'Drop a bank statement here');
      });
      await step('pick the FAKE CSV and preview the parse', async () => {
        await ab.must(['upload', 'input[type="file"][accept=".csv,.ofx,.qif"]', file]);
        await expectText(ab, 'FAKE E2E Bookshop (dummy)');
        await expectText(ab, 'Date range');
      });
      await step('import to database and see the rows', async () => {
        const btn = await tagByText(ab, 'Import to database', { selector: 'button' });
        const ms = await timeMutation(ab, `[...document.querySelectorAll('main tbody tr[data-tx-id]')].some((r) => r.innerText.includes('FAKE E2E Bookshop'))`, () => click(ab, btn), { timeout: 180_000 });
        // The first import on a fresh profile also downloads the embeddings model (embed-on-write); note it.
        ctx.mutation('import 3-row CSV (first import on a fresh profile)', ms);
        if (ms > 5_000) ctx.note(`import took ${ms} ms: the first import blocks on embed-on-write (src/dashboard/api.ts awaits embedTransactionIds, which loads/downloads the embeddings model)`);
        await waitFor(ab, `[...document.querySelectorAll('main tbody tr[data-tx-id]')].filter((r) => r.innerText.includes('FAKE E2E')).length === 3`, { what: '3 imported rows' });
        const after = await txCount(ab);
        if (!after || after.total !== before.total + 3) throw new Error(`count ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        // NN-07: the expense row is negative, the refund positive.
        const amounts = await ab.eval(`[...document.querySelectorAll('main tbody tr[data-tx-id]')].filter((r) => r.innerText.includes('FAKE E2E')).map((r) => r.children[2].innerText.trim())`);
        if (!amounts.some((a) => a.startsWith('-$')) || !amounts.some((a) => a.startsWith('$'))) throw new Error(`amount signs look wrong: ${amounts}`);
        ctx.state.imported = true;
      });
    },
  },
  {
    id: 'P06',
    name: 'Review: confirm one suggestion, correct another',
    tab: 'review',
    covers: ['ReviewTab.tsx', 'issue-86_review-tab-workflow', 'issue-84_review-queue-guardrail'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      let pending;
      const pendingCount = async () => +(/(\d+) pending/.exec(await textOf(ab, MAIN))?.[1] ?? NaN);
      await step('open Review', async () => {
        await gotoTab(ab, 'Review', 'pending');
        await waitFor(ab, `document.querySelectorAll('main tr[data-review-id]').length > 0`, { what: 'review rows' });
        pending = await pendingCount();
        if (!(pending >= 2)) throw new Error(`need 2 pending reviews, have ${pending}`);
      });
      await step('confirm the suggested category', async () => {
        const row = await tagWhere(ab, 'main tr[data-review-id]', `e.innerText.includes('Mystery Vendor')`, { what: 'Mystery Vendor review row' });
        const ms = await timeMutation(ab, `document.querySelector('main').innerText.includes('Applied \\u2018Other\\u2019')`, () => click(ab, `${row} button[title="Apply the suggested category"]`));
        ctx.mutation('review confirm', ms);
        await waitFor(ab, `/${pending - 1} pending/.test(document.querySelector('main').innerText)`, { what: `${pending - 1} pending` });
      });
      await step('correct another to a different category', async () => {
        const row = await tagWhere(ab, 'main tr[data-review-id]', `e.innerText.includes('Pixel Gadgets')`, { what: 'Pixel Gadgets review row' });
        await ab.must(['select', `${row} select`, 'Gifts']);
        const apply = await tagWhere(ab, `${row} button`, `e.innerText.trim() === 'Apply' && !e.disabled`, { what: 'enabled Apply' });
        const ms = await timeMutation(ab, `document.querySelector('main').innerText.includes('Applied \\u2018Gifts\\u2019')`, () => click(ab, apply));
        ctx.mutation('review correct', ms);
        await waitFor(ab, `/${pending - 2} pending/.test(document.querySelector('main').innerText)`, { what: `${pending - 2} pending` });
      });
    },
  },
  {
    id: 'P07',
    name: 'Goals: set a budget, edit a goal',
    tab: 'goals',
    covers: ['GoalsTab.tsx', 'issue-34_percent-income-goals'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open Goals', async () => gotoTab(ab, 'Goals', 'Active goals'));
      await step('set a monthly budget', async () => {
        await ab.must(['select', 'form[aria-label="Set a budget"] select[name="category_id"]', 'Transport']);
        await ab.must(['fill', 'form[aria-label="Set a budget"] input[name="monthly_limit"]', '120']);
        const btn = await tagByText(ab, 'Set budget', { within: 'form[aria-label="Set a budget"]' });
        const ms = await timeMutation(ab, `document.querySelector('main').innerText.includes('Budget for Transport set to $120.00.')`, () => click(ab, btn));
        ctx.mutation('set budget', ms);
        await expectText(ab, 'Transport', { within: MAIN });
      });
      await step('edit a goal target', async () => {
        await ab.must(['select', 'form[aria-label="Edit a goal"] select[name="goal_id"]', '1']);
        await ab.must(['fill', 'form[aria-label="Edit a goal"] input[name="target_amount"]', '6000']);
        const btn = await tagByText(ab, 'Update goal', { within: 'form[aria-label="Edit a goal"]' });
        const ms = await timeMutation(ab, `document.querySelector('main').innerText.includes('Goal #1 updated.')`, () => click(ab, btn));
        ctx.mutation('update goal', ms);
        await expectText(ab, '$6,000.00', { within: MAIN });
      });
    },
  },
  {
    id: 'P08',
    name: 'Forecast: fan chart renders and a what-if moves it',
    tab: 'forecast',
    covers: ['ForecastTab.tsx', 'ForecastFanChart.tsx', 'ForecastControls.tsx', 'issue-42_forecast-tab-monte-carlo', 'issue-81_forecast-what-if-controls'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      const medianLine = () => ab.eval(`(/Median net worth in [^\\n]*/.exec(document.querySelector('main').innerText) || [''])[0]`);
      let before;
      await step('open Forecast; fan chart renders', async () => {
        await gotoTab(ab, 'Forecast', 'Median net worth in', { timeout: 30_000 });
        await waitFor(ab, `document.querySelectorAll('main svg path').length >= 3`, { what: 'fan chart bands' });
        before = await medianLine();
        if (!/\$[\d,]+/.test(before)) throw new Error(`no median figure: ${before}`);
      });
      await step('what-if: raise the real return; projection changes', async () => {
        const slider = 'input[aria-label="Assumed real annual return, percent"]';
        await ab.must(['focus', slider]);
        for (let i = 0; i < 6; i++) await ab.must(['press', 'ArrowRight']);
        await waitFor(ab, `(/Median net worth in [^\\n]*/.exec(document.querySelector('main').innerText) || [''])[0] !== ${q(before)}`, { timeout: 20_000, what: 'median to change' });
        const after = await medianLine();
        ctx.note(`forecast: "${before}" -> "${after}"`);
        await expectNoText(ab, '5.00% real', { within: MAIN });
      });
      await step('reset the what-if', async () => {
        await clickText(ab, 'Reset', { within: MAIN });
        await expectText(ab, '5.00% real', { within: MAIN });
      });
    },
  },
  {
    id: 'P09',
    name: 'Accounts renders',
    tab: 'accounts',
    covers: ['AccountsTab.tsx', 'issue-79_account-wire-types'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open Accounts', async () => gotoTab(ab, 'Accounts', 'Total assets'));
      await step('totals and the account list (or its empty state) render', async () => {
        await expectText(ab, 'Total liabilities', { within: MAIN });
        await expectText(ab, 'Net worth', { within: MAIN });
        const t = await textOf(ab, MAIN);
        const rows = await ab.eval(`document.querySelectorAll('main tbody tr').length`);
        if (await ab.eval(`!!document.querySelector('[data-testid="accounts-load-error"]')`)) throw new Error('accounts failed to load (error card shown)');
        if (!t.includes('No accounts yet.') && rows === 0) throw new Error('no account rows and no empty state');
        if (/NaN|undefined/.test(t)) throw new Error('Accounts shows NaN/undefined');
      });
    },
  },
  {
    id: 'P10',
    name: 'Settings -> Agent access: grant, client token, kill switch',
    tab: 'settings',
    covers: ['AgentAccessCenter.tsx', 'ToolPolicyTable.tsx', 'ClientTokensPanel.tsx', 'KillSwitch.tsx', 'NN-04', 'mcp-client-tokens'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      const liveLine = () => ab.eval(`(/\\d+ tools? live in this tab/.exec(document.querySelector('[data-testid="agent-kill-switch"]')?.innerText ?? '') || [''])[0]`);
      await step('open Settings -> Agent access', async () => {
        await gotoTab(ab, 'Settings', 'Agent access');
        await ab.must(['scrollintoview', '[data-testid="agent-access-center"]']);
      });
      await step('revoke all grants in this tab (clean start)', async () => {
        const btn = await ab.eval(`(() => { const b = [...document.querySelectorAll('[data-testid="agent-access-center"] button')].find((b) => b.innerText.trim() === 'Revoke all in this tab'); return b ? !b.disabled : null; })()`);
        if (btn) {
          await clickText(ab, 'Revoke all in this tab', { within: '[data-testid="agent-access-center"]' });
          await waitFor(ab, `/\\b0 tools live in this tab/.test(document.querySelector('[data-testid="agent-kill-switch"]').innerText)`, { what: '0 tools live' });
        }
      });
      await step('grant a tool to this tab; it is listed as live', async () => {
        const g = await grantTool(ab, 'search_transactions');
        if (g.ms && !g.limited) ctx.mutation('grant tool', g.ms);
        await waitFor(ab, `/\\b1 tool live in this tab/.test(document.querySelector('[data-testid="agent-kill-switch"]').innerText)`, { what: '1 tool live' });
      });
      await step('revoke that grant', async () => {
        const row = await toolRow(ab, 'search_transactions');
        const btn = await tagWhere(ab, `${row} button`, `e.innerText.trim() === 'Revoke'`, { what: 'Revoke in row' });
        const ms = await timeMutation(ab, `[...document.querySelector(${q(row)})?.querySelectorAll('button') ?? []].some((b) => b.innerText.trim() === 'Grant to this tab')`, () => click(ab, btn));
        ctx.mutation('revoke grant', ms);
        if (!/\b0 tools live/.test(await liveLine())) throw new Error(`still live: ${await liveLine()}`);
      });
      const tokenName = `FAKE e2e token ${Date.now() % 100000} (dummy)`;
      await step('mint a client token (shown once)', async () => {
        await ab.must(['fill', 'input[aria-label="Token name"]', tokenName]);
        const box = await tagWhere(ab, '[data-testid="agent-client-tokens"] label', `e.innerText.trim() === 'search_transactions'`, { what: 'search_transactions checkbox' });
        await ab.must(['check', `${box} input[type="checkbox"]`]);
        const mint = await tagByText(ab, 'Mint token', { within: '[data-testid="agent-client-tokens"]' });
        const ms = await timeMutation(ab, `!!document.querySelector('[data-testid="client-token-plaintext"]')`, () => click(ab, mint));
        ctx.mutation('mint client token', ms);
        await expectText(ab, 'Shown once. Store it in your MCP client config now.');
        const tok = await ab.eval(`document.querySelector('[data-testid="client-token-plaintext"]').innerText.trim()`);
        if (!tok || tok.length < 20) throw new Error('token not shown');
        await clickText(ab, 'I saved it');
        await waitFor(ab, `!document.querySelector('[data-testid="client-token-plaintext"]')`, { what: 'token modal closed' });
      });
      await step('the token is listed with its tool', async () => {
        await expectText(ab, tokenName, { within: '[data-testid="agent-client-tokens"]' });
        await expectText(ab, 'search_transactions · expires', { within: '[data-testid="agent-client-tokens"]' });
      });
      await step('revoke the token', async () => {
        const item = await tagWhere(ab, '[data-testid="agent-client-tokens"] div.border', `e.innerText.includes(${q(tokenName)}) && [...e.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Revoke')`, { what: 'token row' });
        const btn = await tagWhere(ab, `${item} button`, `e.innerText.trim() === 'Revoke'`, { what: 'token Revoke' });
        const ms = await timeMutation(ab, `[...document.querySelectorAll('[data-testid="agent-client-tokens"] div.border')].some((e) => e.innerText.includes(${q(tokenName)}) && e.innerText.includes('revoked'))`, () => click(ab, btn));
        ctx.mutation('revoke client token', ms);
      });
      await step('kill switch: turn agent access off (asks first)', async () => {
        await click(ab, 'button[role="switch"][aria-label="Agent access"]');
        await expectText(ab, 'Turn off agent access?');
        const off = await tagByText(ab, 'Turn off', { selector: 'button' });
        const ms = await timeMutation(ab, `document.querySelector('[data-testid="agent-kill-switch"]')?.innerText.includes('Agent access is off.')`, () => click(ab, off));
        ctx.mutation('kill switch off', ms);
        await waitFor(ab, `document.querySelector('button[role="switch"][aria-label="Agent access"]').getAttribute('aria-checked') === 'false'`, { what: 'switch OFF' });
        const tools = await listTools(ab);
        if (tools.length) throw new Error(`WebMCP still exposes ${tools.length} tools with access off`);
      });
      await step('kill switch: turn agent access back on', async () => {
        const ms = await timeMutation(ab, `document.querySelector('button[role="switch"][aria-label="Agent access"]')?.getAttribute('aria-checked') === 'true'`, () => click(ab, 'button[role="switch"][aria-label="Agent access"]'));
        ctx.mutation('kill switch on', ms);
        await waitFor(ab, `/\\b0 tools live in this tab/.test(document.querySelector('[data-testid="agent-kill-switch"]').innerText)`, { what: 'on, 0 tools live (grants do not come back)' });
      });
    },
  },
  {
    id: 'P11',
    name: 'WebMCP surface: inventory per tab, reads work, writes wait for approval',
    tab: 'settings',
    covers: ['webmcp-bridge.ts', 'specs/webmcp-threat-model.md', 'specs/webmcp-tool-naming.md', 'NN-03', 'NN-04', 'NN-06'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step, skip } = ctx;
      const inv = ctx.webmcp;
      await step('grant every tool to this tab', async () => {
        await gotoTab(ab, 'Settings', 'Agent access');
        inv.catalog = await ab.eval(`[...document.querySelectorAll('[data-testid="agent-tool-policies"] > div .font-mono')].map((e) => e.textContent)`);
        let limited = 0;
        for (const name of inv.catalog) limited += (await grantTool(ab, name)).limited;
        if (limited) ctx.note(`granting ${inv.catalog.length} tools hit the 20/min grant rate limit ${limited} time(s); waited and retried`);
        const notGranted = await ab.eval(`[...document.querySelectorAll('[data-testid="agent-tool-policies"] > div')].slice(1).filter((r) => !r.innerText.includes('Granted')).map((r) => r.querySelector('.font-mono').textContent)`);
        if (notGranted.length) throw new Error(`not granted: ${notGranted.join(', ')}`);
      });
      const TABS = ['Overview', 'Transactions', 'Review', 'Accounts', 'Goals', 'Forecast', 'Chat', 'LLM', 'Logs', 'Settings'];
      for (const label of TABS) {
        await step(`list tools on ${label}`, async () => {
          await gotoTab(ab, label);
          ctx.visit(label.toLowerCase());
          // Registrations settle asynchronously after a tab switch: read until two consecutive lists agree.
          let prev = null;
          let tools = [];
          for (let i = 0; i < 20; i++) {
            await sleep(350);
            tools = await listTools(ab);
            const sig = tools.map((t) => t.name).sort().join(',');
            if (sig === prev && tools.length > 0) break;
            prev = sig;
          }
          inv.byTab[label.toLowerCase()] = tools.map((t) => t.name).sort();
          for (const t of tools) inv.meta[t.name] = { readOnly: !!t.annotations?.readOnly, consequential: !!t.annotations?.consequential, untrustedContent: !!t.annotations?.untrustedContent };
          if (tools.length === 0) throw new Error(`no tools registered on ${label}`);
        });
      }
      // Read-only tools: each must answer with data, no approval card, on a tab where it is registered.
      const READS = {
        search_transactions: { query: 'cafe' },
        get_spending_summary: { period: 'month' },
        get_profit_loss: { period: 'month' },
        get_net_worth: { action: 'summary' },
        get_cash_forecast: {},
        get_tax_summary: { action: 'summary' },
        get_page_context: {},
        list_review_items: {},
        list_interactions: { limit: 5 },
        get_interaction: { id: 1, section: 'overview' },
        get_judge_rubric: {},
      };
      const tabFor = (tool) => Object.entries(inv.byTab).find(([, names]) => names.includes(tool))?.[0];
      const label = (tab) => TABS.find((t) => t.toLowerCase() === tab);
      for (const [tool, params] of Object.entries(READS)) {
        await step(`read: ${tool}`, async () => {
          const tab = tabFor(tool);
          if (!tab) skip(`${tool} is not registered on any tab`);
          await gotoTab(ab, label(tab));
          await sleep(500);
          const t0 = Date.now();
          const r = await invoke(ab, tool, params);
          const ms = Date.now() - t0;
          inv.invoked[tool] = { tab, params, status: r.data?.status ?? 'error', ms };
          if (!r.ok || r.data?.status !== 'completed') throw new Error(`${tool}: ${r.error ?? r.data?.status}`);
          const out = r.data.output;
          if (out?.error) throw new Error(`${tool} returned error ${JSON.stringify(out.error)}`);
          if (tool === 'get_judge_rubric') inv.rubricVersion = out?.version ?? out?.rubricVersion ?? null;
          if (await ab.eval(CARD_VISIBLE)) throw new Error(`${tool} (read) raised an approval card`);
          if (tool === 'search_transactions' && !(out?.items?.length > 0)) throw new Error('search_transactions returned no rows');
          if (tool === 'search_transactions' && JSON.stringify(out).includes('<img')) throw new Error('untrusted markup in result');
          inv.invoked[tool].covered = true;
        });
      }
      // Page tools: they move the view, never data.
      const PAGE = [
        ['fill_transaction_filters', 'Transactions', { search: 'Taco' }, `(() => { const rows = [...document.querySelectorAll('main tbody tr[data-tx-id]')]; return rows.length > 0 && rows.every((r) => r.innerText.includes('Taco')); })()`],
        ['open_transaction', 'Transactions', null, `!!document.querySelector('main tr[aria-current="true"]')`],
        ['open_review_item', 'Review', null, `!!document.querySelector('form[aria-label="Resolve a review"] select[name="review_id"]')?.value`],
        ['open_interaction', 'LLM', { id: 1 }, `!!document.querySelector('dialog[open]')`],
        ['fill_forecast_inputs', 'Forecast', { monthly_income: 5000 }, `document.querySelector('input[name="monthly_income"]')?.value === '5000'`],
        ['open_tab', 'Overview', { tab: 'goals' }, `[...document.querySelectorAll('nav button')].find((b) => b.innerText.trim() === 'Goals')?.className.includes('border-b-green')`],
      ];
      for (const [tool, tabLabel, params0, doneJs] of PAGE) {
        await step(`page: ${tool}`, async () => {
          if (!inv.byTab[tabLabel.toLowerCase()]?.includes(tool)) skip(`${tool} not registered on ${tabLabel}`);
          await gotoTab(ab, tabLabel);
          await sleep(500);
          let params = params0;
          if (tool === 'open_transaction') params = { id: await ab.eval(`+document.querySelector('main tbody tr[data-tx-id]')?.dataset.txId`) };
          if (tool === 'open_review_item') params = { reviewId: await ab.eval(`+document.querySelector('main tr[data-review-id]')?.dataset.reviewId`) };
          if (tool === 'open_review_item' && !params.reviewId) skip('no pending review left to open');
          const r = await invoke(ab, tool, params);
          inv.invoked[tool] = { tab: tabLabel.toLowerCase(), params, status: r.data?.status ?? 'error' };
          if (!r.ok || r.data?.status !== 'completed') throw new Error(`${tool}: ${r.error ?? r.data?.status}`);
          if (r.data.output?.error) throw new Error(`${tool} refused: ${JSON.stringify(r.data.output.error)}`);
          await waitFor(ab, doneJs, { what: `${tool} visible effect` });
          inv.invoked[tool].covered = true;
          if (tool === 'open_interaction') {
            // The detail panel carries the declarative propose_judgment form: inventory the tab while it is open.
            await sleep(700);
            inv.byTab['llm+detail'] = (await listTools(ab)).map((t) => t.name).sort();
          }
          if (await ab.eval(`!!document.querySelector('dialog[open]')`)) {
            // Close with the dialog's own x button. (Do not press Escape: in headless Chrome 156 an agent-browser
            // Escape flips document.visibilityState to "hidden" for the rest of the session, and the bridge draws no
            // approval cards in a hidden tab.)
            await clickText(ab, '\u00d7', { within: 'dialog[open]' });
            await waitFor(ab, `!document.querySelector('dialog[open]')`, { what: 'dialog closed' });
          }
        });
      }
      // Change tools: NN-03. Every one must raise the approval card and change nothing until a person approves; we reject.
      let target;
      await step('mutating: update_transaction raises a card, reject leaves the row unchanged', async () => {
        await gotoTab(ab, 'Transactions', 'transactions');
        target = await ab.eval(`(() => { const r = [...document.querySelectorAll('main tbody tr[data-tx-id]')].find((r) => r.innerText.includes('Corner Cafe')); return r ? { id: +r.dataset.txId, cat: ${CATEGORY_CELL}(r) } : null; })()`);
        if (!target) throw new Error('no Corner Cafe row');
        const r = await invoke(ab, 'update_transaction', { id: target.id, category: 'Groceries' }, { detach: true });
        if (!r.ok || r.data?.status !== 'pending') throw new Error(`expected a pending invocation, got ${JSON.stringify(r.data?.status ?? r.error)}`);
        try {
          await waitFor(ab, CARD_VISIBLE, { what: 'approval card', timeout: 15_000 });
        } catch (e) {
          const res = await webmcpResult(ab, r.data.invocationId, 3_000);
          const st = await ab.eval(`(async () => { const h = { Authorization: 'Bearer ' + localStorage.getItem('wilson_auth_token') }; const s = await (await fetch('/api/mcp/state', { headers: h })).json(); return { pending: (s.pending || []).map((p) => p.tool + ':' + p.status), enabled: s.enabled }; })()`);
          const names = (await listTools(ab)).map((t) => t.name);
          const vis = await ab.eval('document.visibilityState');
          throw new Error(`${e.message}; visibility: ${vis}; invocation: ${JSON.stringify(res.data?.output ?? res.data?.status ?? res.error)}; state: ${JSON.stringify(st)}; registered: ${names.join(',')}`);
        }
        await expectText(ab, 'Confirm: Update Transaction');
        const mid = await invoke(ab, 'search_transactions', { query: 'Corner Cafe' });
        const midRow = mid.data?.output?.items?.find((i) => i.id === target.id);
        if (midRow && midRow.category !== target.cat) throw new Error(`changed before approval: ${target.cat} -> ${midRow.category}`);
        await rejectCard(ab);
        const res = await webmcpResult(ab, r.data.invocationId);
        const outcome = res.data?.output?.outcome;
        inv.invoked.update_transaction = { tab: 'transactions', status: outcome ?? res.data?.status ?? 'error', card: true, covered: outcome === 'rejected' };
        if (outcome !== 'rejected') throw new Error(`expected outcome rejected, got ${JSON.stringify(res.data?.output ?? res.error)}`);
        const after = await invoke(ab, 'search_transactions', { query: 'Corner Cafe' });
        const row = after.data?.output?.items?.find((i) => i.id === target.id);
        if (!row || row.category !== target.cat) throw new Error(`row changed after reject: ${JSON.stringify(row)}`);
      });
      // Imperative change tools: the call itself raises the card.
      const WRITES = [
        ['categorize_transaction', 'Transactions', () => ({ id: target?.id ?? 1, category: 'Groceries' })],
        ['set_tax_flag', 'Transactions', () => ({ action: 'flag', transactionId: target?.id ?? 1, irsCategory: 'Advertising', taxYear: new Date().getFullYear() })],
      ];
      for (const [tool, tabLabel, mk] of WRITES) {
        await step(`mutating: ${tool} waits for approval (rejected)`, async () => {
          if (!inv.byTab[tabLabel.toLowerCase()]?.includes(tool)) skip(`${tool} not registered on ${tabLabel}`);
          await gotoTab(ab, tabLabel);
          await sleep(600);
          const params = await mk();
          const r = await invoke(ab, tool, params, { detach: true });
          if (!r.ok) throw new Error(`${tool}: ${r.error}`);
          let card = false;
          try { await waitFor(ab, CARD_VISIBLE, { timeout: 10_000, what: 'approval card' }); card = true; } catch { /* checked below */ }
          if (!card) {
            const res = await webmcpResult(ab, r.data.invocationId, 3_000);
            const out = res.data?.output;
            inv.invoked[tool] = { tab: tabLabel.toLowerCase(), params, status: out?.outcome ?? res.data?.status ?? 'error', card: false, covered: false };
            if (out?.outcome === 'committed') throw new Error(`NN-03: ${tool} committed without a card: ${JSON.stringify(out)}`);
            throw new Error(`${tool}: no approval card (visibility ${await ab.eval('document.visibilityState')}); result ${JSON.stringify(out ?? res.data?.status ?? res.error)}`);
          }
          await rejectCard(ab);
          const res = await webmcpResult(ab, r.data.invocationId);
          const out = res.data?.output;
          inv.invoked[tool] = { tab: tabLabel.toLowerCase(), params, status: out?.outcome ?? res.data?.status ?? 'error', card: true, covered: out?.outcome === 'rejected' };
          if (out?.outcome !== 'rejected') throw new Error(`${tool}: outcome ${JSON.stringify(out ?? res.error)} after reject`);
          await waitFor(ab, `!(${CARD_VISIBLE})`, { what: 'card gone' });
        });
      }
      // Declarative change forms: the agent only FILLS the form ("Agent filled this form — review before submitting.");
      // nothing is sent until a person submits it, and that submit goes through the same approval card.
      const FORMS = [
        ['set_budget', 'Goals', 'Set a budget', 'Set budget', () => ({ category_id: '1', monthly_limit: 999 }), `document.querySelector('main').innerText.includes('$999.00')`],
        ['update_goal', 'Goals', 'Edit a goal', 'Update goal', () => ({ goal_id: '1', target_amount: 9999 }), `document.querySelector('main').innerText.includes('$9,999.00')`],
        ['resolve_review_item', 'Review', 'Resolve a review', 'Resolve', async () => ({ review_id: String(await ab.eval(`+document.querySelector('main tr[data-review-id]')?.dataset.reviewId || 0`)), action: 'confirm' }), null],
      ];
      for (const [tool, tabLabel, form, submit, mk, changedJs] of FORMS) {
        await step(`mutating form: ${tool} is filled, then waits for a person + approval (rejected)`, async () => {
          if (!inv.byTab[tabLabel.toLowerCase()]?.includes(tool)) skip(`${tool} not registered on ${tabLabel}`);
          await gotoTab(ab, tabLabel);
          await sleep(600);
          const params = await mk();
          if (tool === 'resolve_review_item' && params.review_id === '0') skip('no pending review left');
          const pendingBefore = tool === 'resolve_review_item' ? await ab.eval(`document.querySelectorAll('main tr[data-review-id]').length`) : null;
          const r = await invoke(ab, tool, params, { detach: true });
          if (!r.ok) throw new Error(`${tool}: ${r.error}`);
          await expectText(ab, 'Agent filled this form — review before submitting.', { within: MAIN });
          if (await ab.eval(CARD_VISIBLE)) throw new Error(`${tool}: a card appeared before any person submitted`);
          if (changedJs && (await ab.eval(changedJs))) throw new Error(`NN-03: ${tool} changed data on fill`);
          const btn = await tagByText(ab, submit, { within: `form[aria-label="${form}"]` });
          await click(ab, btn);
          await waitFor(ab, CARD_VISIBLE, { timeout: 10_000, what: 'approval card after the human submit' });
          await rejectCard(ab);
          const res = await webmcpResult(ab, r.data.invocationId);
          const out = res.data?.output;
          inv.invoked[tool] = { tab: tabLabel.toLowerCase(), params, status: out?.outcome ?? res.data?.status ?? 'error', card: true, covered: true };
          await waitFor(ab, `!(${CARD_VISIBLE})`, { what: 'card gone' });
          if (changedJs && (await ab.eval(changedJs))) throw new Error(`NN-03: ${tool} changed data after reject`);
          if (pendingBefore !== null) {
            const after = await ab.eval(`document.querySelectorAll('main tr[data-review-id]').length`);
            if (after !== pendingBefore) throw new Error(`review queue changed after reject: ${pendingBefore} -> ${after}`);
          }
          if (out?.outcome && out.outcome !== 'rejected') throw new Error(`${tool}: outcome ${out.outcome} after reject`);
        });
      }
      await step('proposal: propose_judgments waits for the person (refused), nothing is proposed', async () => {
        if (!inv.byTab.llm?.includes('propose_judgments')) skip('propose_judgments not registered on LLM');
        if (!inv.rubricVersion) skip('no rubric version from get_judge_rubric');
        await gotoTab(ab, 'LLM', 'Total calls');
        await sleep(600);
        const params = { judgeModel: 'fake-judge-dummy', rubricVersion: String(inv.rubricVersion), items: [{ interactionId: 4, rating: 3, rationale: 'FAKE e2e rationale (dummy)' }] };
        const r = await invoke(ab, 'propose_judgments', params, { detach: true });
        if (!r.ok) throw new Error(`propose_judgments: ${r.error}`);
        let card = false;
        try { await waitFor(ab, CARD_VISIBLE, { timeout: 10_000, what: 'approval card' }); card = true; } catch { /* below */ }
        if (!card) {
          const res = await webmcpResult(ab, r.data.invocationId, 3_000);
          throw new Error(`no card for propose_judgments; result ${JSON.stringify(res.data?.output ?? res.data?.status ?? res.error)}`);
        }
        await rejectCard(ab);
        const res = await webmcpResult(ab, r.data.invocationId);
        inv.invoked.propose_judgments = { tab: 'llm', params, status: res.data?.output?.outcome ?? res.data?.status ?? 'error', card: true, covered: true };
        await clickText(ab, 'Judge queue', { within: MAIN });
        await expectText(ab, '0 proposals', { within: MAIN });
      });
    },
  },
  {
    id: 'P12',
    name: 'LLM tab: traces, training interactions, judge queue',
    tab: 'llm',
    covers: ['LlmTab.tsx', 'JudgeQueue.tsx', 'specs/webmcp-judge-full-results.md'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open LLM (traces)', async () => gotoTab(ab, 'LLM', 'Total calls'));
      await step('Training lists the seeded interactions', async () => {
        await clickText(ab, 'Training', { within: MAIN });
        await expectText(ab, 'interactions loaded', { within: MAIN });
        await waitFor(ab, `document.querySelectorAll('main tbody tr').length >= 20`, { what: '>= 20 interaction rows' });
        await expectText(ab, 'fake-model (dummy)', { within: MAIN });
      });
      await step('Judge queue renders', async () => {
        await clickText(ab, 'Judge queue', { within: MAIN });
        await expectText(ab, 'Proposals are inert until you accept them', { within: MAIN });
      });
    },
  },
  {
    id: 'P13',
    name: 'Chat: slash help answers locally; model chat',
    tab: 'chat',
    covers: ['ChatTab.tsx', 'chat-commands.ts', 'NN-01'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step, skip } = ctx;
      await step('open Chat', async () => gotoTab(ab, 'Chat', 'Ask Wilson anything'));
      await step('/help is answered without any model', async () => {
        await ab.must(['fill', 'textarea[aria-label="Message Wilson"]', '/help']);
        await clickText(ab, 'Send', { within: MAIN });
        await expectText(ab, '/overview — Go to Overview', { within: MAIN, timeout: 15_000 });
        await expectText(ab, 'Navigation', { within: MAIN });
      });
      await step('a model-backed question', async () => {
        skip('needs a cloud key or a local model (Ollama / WebGPU download); the suite adds neither');
      });
    },
  },
  {
    id: 'P14',
    name: 'Logs renders',
    tab: 'logs',
    covers: ['LogsTab.tsx'],
    needs: ['admin'],
    async run(ctx) {
      const { ab, step } = ctx;
      await step('open Logs; entries listed', async () => {
        await gotoTab(ab, 'Logs', 'Info');
        await waitFor(ab, `/\\b(INFO|WARN|ERROR|DEBUG)\\b/.test(document.querySelector('main').innerText)`, { what: 'a log row' });
      });
      await step('level filter: Error', async () => {
        await clickText(ab, 'Error', { within: MAIN });
        await waitFor(ab, `!/\\bINFO\\b/.test(document.querySelector('main').innerText)`, { what: 'INFO rows filtered out' });
        await clickText(ab, 'All', { within: MAIN });
      });
    },
  },
];
