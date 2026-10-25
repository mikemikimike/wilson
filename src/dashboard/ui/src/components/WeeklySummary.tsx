import { useApi } from '@/hooks/useApi';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { money } from '@/format';
import { useAppState } from '@/state';
import { entityScopedPath } from '@/lib/overviewQueries';
import { weeklyChange } from '@/lib/weeklyChange';
import type { WeeklySummaryData, StreakData } from '@/types';

export function WeeklySummary() {
  const { entityId } = useAppState();
  const { data: weekData, loading: loadingWeek, offline: offlineWeek } = useApi<WeeklySummaryData>(
    entityScopedPath('/api/weekly-summary', entityId),
  );
  const { data: streakData, loading: loadingStreak, offline: offlineStreak } = useApi<StreakData>(
    entityScopedPath('/api/streak', entityId),
  );

  if (loadingWeek || loadingStreak) {
    return (
      <div key="weekly-skeleton" className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[70px] md:h-[47px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!weekData && (offlineWeek || offlineStreak)) {
    // Mirror unavailable or never seeded — say so rather than implying empty data.
    return <OfflineUnavailable title="This Week" />;
  }

  if (!weekData) {
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">This Week</h3>
        <p className="text-sm text-text-muted">No spending data yet.</p>
      </div>
    );
  }

  const { thisWeek, lastWeek, change } = weekData;
  const delta = weeklyChange(thisWeek.total, lastWeek.total, change.amount, change.percent);

  const topCat = thisWeek.byCategory.length > 0
    ? thisWeek.byCategory.reduce((a, b) => (b.total > a.total ? b : a))
    : null;

  const streak = streakData?.current ?? 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">This Week</h3>
      <p className="text-sm text-text leading-relaxed">
        <span className="font-mono font-semibold tabular-nums text-text">
          {money(Math.abs(thisWeek.total))}
        </span>{' '}
        spent{' '}
        {delta.kind === 'change' ? (
          <span className={`font-semibold ${delta.down ? 'text-green' : 'text-red'}`}>
            ({delta.down ? '\u2193' : '\u2191'}{delta.percent}% vs last week)
          </span>
        ) : (
          <span className="text-text-muted">
            {delta.kind === 'none' ? '(no spending recorded this week or last)' : '(no spending last week to compare)'}
          </span>
        )}
        {topCat && (
          <>
            . Top category:{' '}
            <span className="text-text">{topCat.category}</span>{' '}
            <span className="font-mono tabular-nums text-text-muted">
              ({money(Math.abs(topCat.total))})
            </span>
          </>
        )}
        {streak > 0 && (
          <>
            . Streak: <span className="text-green font-semibold">{streak} days</span>
          </>
        )}
        .
      </p>
    </div>
  );
}
