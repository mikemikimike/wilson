import { describe, expect, test } from 'bun:test';
import {
  bundleWindow,
  buildBundle,
  buildLocalSystemPrompt,
  computeBundleTotals,
  localIsoDate,
  projectTransactions,
  COMPUTED_TOTALS_MARKER,
  type BundleTxn,
} from '../dashboard/ui/src/hybrid/core.js';

/**
 * In-tab (bundle mode) totals. Gemma E2B summed raw rows wrong (Oct 18 seed:
 * dining really $159.50, it said $215.50; groceries really $258.60, it said
 * $322.30), and the rows were a rolling 30 days, so "this month" was ill-posed.
 * The bundle now carries JS-computed totals for this calendar month and last
 * calendar month, over rows fetched from the 1st of last month.
 *
 * Every test injects "today" as a LOCAL date (new Date(y, m, d, h)), so none
 * of them depend on the clock or cross a month boundary by accident (#141).
 */

const OCT_18 = new Date(2026, 9, 18, 12, 0, 0);

describe('localIsoDate', () => {
  test('formats the LOCAL calendar date, even late in the evening', () => {
    // 23:30 local is already the next day in UTC for any zone west of UTC;
    // toISOString() would say 2026-10-19 there.
    expect(localIsoDate(new Date(2026, 9, 18, 23, 30))).toBe('2026-10-18');
    expect(localIsoDate(new Date(2026, 9, 18, 0, 5))).toBe('2026-10-18');
    expect(localIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('bundleWindow', () => {
  test('Oct 18: fetch from Sep 1 through today; this month = Oct 1..18, last month = Sep 1..30', () => {
    expect(bundleWindow(OCT_18)).toEqual({
      start: '2026-09-01',
      end: '2026-10-18',
      thisMonth: { start: '2026-10-01', end: '2026-10-18' },
      lastMonth: { start: '2026-09-01', end: '2026-09-30' },
    });
  });

  test('January wraps to December of the previous year', () => {
    const w = bundleWindow(new Date(2027, 0, 5, 9));
    expect(w.start).toBe('2026-12-01');
    expect(w.lastMonth).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(w.thisMonth).toEqual({ start: '2027-01-01', end: '2027-01-05' });
  });

  test('the 1st of a month: this month is one day, last month is the whole previous month', () => {
    const w = bundleWindow(new Date(2026, 2, 1, 8));
    expect(w.thisMonth).toEqual({ start: '2026-03-01', end: '2026-03-01' });
    expect(w.lastMonth).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  test('the 31st does not overflow into the wrong previous month', () => {
    // Naive setMonth(m - 1) on Mar 31 lands on Mar 3 (Feb 31 rolls over).
    const w = bundleWindow(new Date(2026, 2, 31, 22));
    expect(w.lastMonth).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(w.start).toBe('2026-02-01');
    expect(w.end).toBe('2026-03-31');
  });

  test('leap-year February ends on the 29th', () => {
    expect(bundleWindow(new Date(2028, 2, 10)).lastMonth.end).toBe('2028-02-29');
  });
});

describe('projectTransactions over the calendar window', () => {
  const row = (date: string) => ({ date, description: 'X', amount: -1, category: 'Dining', merchant_name: 'LEAK' });

  test('keeps rows from the window start (inclusive) and drops anything older', () => {
    const out = projectTransactions([row('2026-10-18'), row('2026-09-01'), row('2026-08-31')], { start: '2026-09-01', limit: 100 });
    expect(out.map((r) => r.date)).toEqual(['2026-09-01', '2026-10-18']);
  });

  test('drops rows after the window end when one is given', () => {
    const out = projectTransactions([row('2026-10-19'), row('2026-10-18')], { start: '2026-09-01', end: '2026-10-18', limit: 100 });
    expect(out.map((r) => r.date)).toEqual(['2026-10-18']);
  });
});

// ── Regression: the Oct 18 seed shape ───────────────────────────────────────

/**
 * Newest-first like GET /api/transactions. This month's dining rows sum to
 * $159.50 and groceries to $258.60. The late-September rows are what a rolling
 * 30-day window added on top: $159.50 + $56.00 = $215.50 and $258.60 + $63.70
 * = $322.30, exactly Gemma's wrong answers.
 */
const SEED_ROWS = [
  { date: '2026-10-17', description: 'BLUE PLATE DINER', amount: -37.2, category: 'Dining' },
  { date: '2026-10-16', description: 'WHOLE FOODS', amount: -46.85, category: 'Groceries' },
  { date: '2026-10-14', description: 'TACO STAND', amount: -61.3, category: 'Dining' },
  { date: '2026-10-12', description: 'TRADER JOES', amount: -71.15, category: 'Groceries' },
  { date: '2026-10-10', description: 'COFFEE BAR', amount: -18.25, category: 'Dining' },
  { date: '2026-10-08', description: 'SAFEWAY', amount: -56.48, category: 'Groceries' },
  { date: '2026-10-05', description: 'PAYROLL ACME', amount: 3200, category: 'Income' },
  { date: '2026-10-04', description: 'NOODLE HOUSE', amount: -42.75, category: 'Dining' },
  { date: '2026-10-02', description: 'COSTCO', amount: -84.12, category: 'Groceries' },
  { date: '2026-10-01', description: 'TO SAVINGS', amount: -500, category: 'Transfer' },
  { date: '2026-09-25', description: 'SAFEWAY', amount: -63.7, category: 'Groceries' },
  { date: '2026-09-22', description: 'STEAKHOUSE', amount: -56, category: 'Dining' },
  { date: '2026-09-15', description: 'PAYROLL ACME', amount: 3200, category: 'Income' },
  { date: '2026-09-03', description: 'CORNER CAFE', amount: -12.4, category: null },
];

describe('computeBundleTotals', () => {
  const window = bundleWindow(OCT_18);
  const txns = projectTransactions(SEED_ROWS, { start: window.start, end: window.end, limit: 500 });
  const totals = computeBundleTotals(txns, window, { limitHit: false });

  test('regression: this month dining is $159.50 and groceries $258.60 (not the rolling-30-day $215.50 / $322.30)', () => {
    const byCat = Object.fromEntries(totals.thisMonth.spendingByCategory.map((l) => [l.label, l.amount]));
    expect(byCat.Dining).toBe(159.5);
    expect(byCat.Groceries).toBe(258.6);
  });

  test('last month is its own calendar month', () => {
    const byCat = Object.fromEntries(totals.lastMonth.spendingByCategory.map((l) => [l.label, l.amount]));
    expect(byCat).toEqual({ Groceries: 63.7, Dining: 56, Uncategorized: 12.4 });
    expect(totals.lastMonth.moneyIn).toBe(3200);
  });

  test('spend is positive dollars; income is kept separate; transfers stay out of total spending', () => {
    expect(totals.thisMonth.spending).toBe(418.1); // 159.50 + 258.60, no $500 transfer
    expect(totals.thisMonth.moneyIn).toBe(3200);
    expect(totals.thisMonth.moneyInByCategory).toEqual([{ label: 'Income', amount: 3200 }]);
    // The transfer is still listed as its own category line, so it can be quoted.
    expect(totals.thisMonth.spendingByCategory).toContainEqual({ label: 'Transfer', amount: 500 });
    for (const l of totals.thisMonth.spendingByCategory) expect(l.amount).toBeGreaterThan(0);
  });

  test('categories are ordered by amount, largest first', () => {
    expect(totals.thisMonth.spendingByCategory.map((l) => l.label)).toEqual(['Transfer', 'Groceries', 'Dining']);
  });

  test('sums in cents, so float drift never shows up (0.1 + 0.2)', () => {
    const t = computeBundleTotals(
      [
        { date: '2026-10-01', description: 'a', amount: -0.1, category: 'Fees' },
        { date: '2026-10-02', description: 'b', amount: -0.2, category: 'Fees' },
      ],
      window,
      { limitHit: false },
    );
    expect(t.thisMonth.spendingByCategory).toEqual([{ label: 'Fees', amount: 0.3 }]);
  });

  test('reliability: hitting the fetch row limit marks the totals unreliable', () => {
    expect(totals.reliable).toBe(true);
    expect(totals.fetchedRows).toBe(SEED_ROWS.length);
    expect(computeBundleTotals(txns, window, { limitHit: true }).reliable).toBe(false);
  });
});

describe('buildBundle with computed totals', () => {
  const window = bundleWindow(OCT_18);
  const txns = projectTransactions(SEED_ROWS, { start: window.start, end: window.end, limit: 500 });
  const totals = computeBundleTotals(txns, window, { limitHit: false });
  const params = { limit: 500, maxChars: 6000 };

  test('renders an honest Period line for the calendar window', () => {
    const b = buildBundle(txns, null, params, { window, totals });
    expect(b.text).toContain(
      `Period: 2026-09-01..2026-10-18 (1st of last month through today, ${txns.length} of ${txns.length} transactions shown)`,
    );
    expect(b.text).not.toContain('last 30 days');
  });

  test('renders this month and last month totals with category lines', () => {
    const b = buildBundle(txns, null, params, { window, totals });
    expect(b.text).toContain(COMPUTED_TOTALS_MARKER);
    expect(b.text).toContain('This month (2026-10-01..2026-10-18): total spending $418.10; money in $3,200.00');
    expect(b.text).toContain('Dining $159.50');
    expect(b.text).toContain('Groceries $258.60');
    expect(b.text).toContain('Last month (2026-09-01..2026-09-30): total spending $132.10; money in $3,200.00');
    // Totals come before the rows, so the model reads them first.
    expect(b.text.indexOf(COMPUTED_TOTALS_MARKER)).toBeLessThan(b.text.indexOf('Transactions (date'));
  });

  test('the size guard drops rows, never the totals', () => {
    const many: BundleTxn[] = Array.from({ length: 300 }, (_, i) => ({
      date: i < 150 ? '2026-09-10' : '2026-10-10',
      description: `ROW ${i} WITH A LONG DESCRIPTION`,
      amount: -1,
      category: i % 2 ? 'Dining' : 'Groceries',
    }));
    const t = computeBundleTotals(many, window, { limitHit: false });
    const b = buildBundle(many, null, { limit: 500, maxChars: 2500 }, { window, totals: t });
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBeLessThanOrEqual(2500);
    expect(b.rowCount).toBeLessThan(300);
    // Totals reflect all 300 fetched rows, not just the rows kept after truncation.
    expect(b.text).toContain('This month (2026-10-01..2026-10-18): total spending $150.00');
    expect(b.text).toContain('Last month (2026-09-01..2026-09-30): total spending $150.00');
    expect(b.text).toContain('Dining $75.00');
  });

  test('unreliable totals are not rendered and say why', () => {
    const t = computeBundleTotals(txns, window, { limitHit: true });
    const b = buildBundle(txns, null, params, { window, totals: t });
    expect(b.text).toContain('Computed totals: unavailable');
    expect(b.text).toContain('NEED_MORE_DATA');
    expect(b.text).not.toContain('$159.50');
    expect(b.allowedCents).not.toContain(15950);
  });

  test('allowedCents holds the totals, the weekly figures and the shown row amounts', () => {
    const weekly = {
      thisWeek: { total: 98.45, topCategory: 'Dining' },
      lastWeek: { total: 120, topCategory: 'Groceries' },
      change: { amount: -21.55, percent: -18 },
    };
    const b = buildBundle(txns, weekly, params, { window, totals });
    const allowed = new Set(b.allowedCents);
    for (const cents of [15950, 25860, 41810, 320000, 13210, 9845, 12000, 2155, 3720, 4685]) {
      expect(allowed.has(cents)).toBe(true);
    }
    expect(allowed.has(21550)).toBe(false);
    expect(allowed.has(32230)).toBe(false);
  });
});

describe('local system prompt', () => {
  const prompt = buildLocalSystemPrompt('2026-10-18');

  test('says to quote computed totals verbatim and never add rows', () => {
    expect(prompt).toContain('Computed totals');
    expect(prompt).toMatch(/verbatim/i);
    expect(prompt).toMatch(/never add up/i);
  });

  test('a total that is not listed is a NEED_MORE_DATA hand-off', () => {
    expect(prompt).toMatch(/total that is not listed[^\n]*NEED_MORE_DATA/);
  });
});
