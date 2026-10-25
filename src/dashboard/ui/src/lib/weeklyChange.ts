/**
 * The "vs last week" clause on the This Week card. Pure: WeeklySummary renders it,
 * src/__tests__/weekly-change.test.ts pins it.
 *
 * A percent is only meaningful against spending last week. With none, "↓0%" read as a
 * real (green) result to a first-timer whose data was older than this week (2026-10-25),
 * so say plainly that there is nothing to compare instead.
 */
export type WeeklyChange =
  | { kind: 'none' }
  | { kind: 'no-baseline' }
  | { kind: 'change'; down: boolean; percent: string };

export function weeklyChange(thisWeekTotal: number, lastWeekTotal: number, changeAmount: number, changePercent: number): WeeklyChange {
  const thisSpent = Math.abs(thisWeekTotal);
  const lastSpent = Math.abs(lastWeekTotal);
  if (thisSpent === 0 && lastSpent === 0) return { kind: 'none' };
  if (lastSpent === 0) return { kind: 'no-baseline' };
  return { kind: 'change', down: changeAmount <= 0, percent: Math.abs(changePercent).toFixed(0) };
}
