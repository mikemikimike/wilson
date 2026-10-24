import { describe, expect, test } from 'bun:test';
import { budgetStatus, heatmapSummary } from '../dashboard/ui/src/lib/heatmapGrid.js';
import { parseHash, tabHash } from '../dashboard/ui/src/lib/urlState.js';

describe('budget states (#198)', () => {
  test('budgetStatus separates set / none / unknown', () => {
    expect(budgetStatus({ dailyBudget: 50 })).toBe('set');
    expect(budgetStatus({ dailyBudget: 0 })).toBe('none');
    expect(budgetStatus(null)).toBe('unknown');
  });

  test('unknown budget makes no verdict and does not claim "no budget"', () => {
    const s = heatmapSummary({ underBudgetDays: 0, totalDays: 10 }, '$0.00', false, false, false);
    expect(s.tally).toBeNull();
    expect(s.needsBudget).toBe(false);
    expect(s.takeaway).toContain("Couldn't load your budget");
    expect(s.takeaway).not.toContain('No budget is set');
  });

  test('known no-budget still prompts', () => {
    expect(heatmapSummary({ underBudgetDays: 0, totalDays: 10 }, '$0.00', false, false, true).needsBudget).toBe(true);
  });

  test('goals link keeps the global filters and drops tab-scoped keys', () => {
    const href = tabHash(parseHash('#overview?preset=quarter&account=2&cat=Dining&day=2026-01-05'), 'goals');
    expect(href).toBe('#goals?preset=quarter&account=2&cat=Dining');
    expect(tabHash(parseHash('#overview'), 'goals')).toBe('#goals');
  });
});
