import { useApi } from '@/hooks/useApi';
import { OfflineUnavailable } from '@/components/OfflineUnavailable';
import { useAppState } from '@/state';
import { useUrlState } from '@/hooks/useUrlState';
import { tabHash } from '@/lib/urlState';
import { budgetStatus } from '@/lib/heatmapGrid';
import { entityScopedPath } from '@/lib/overviewQueries';
import type { StreakData } from '@/types';

export function StreakCounter() {
  const { entityId } = useAppState();
  const { state: urlState } = useUrlState();
  const { data, loading, offline, refetch } = useApi<StreakData>(entityScopedPath('/api/streak', entityId));

  if (loading) {
    return (
      <div key="streak-skeleton" className="bg-surface-raised border border-border rounded-lg p-4">
        <div className="h-[92px] md:h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (offline && !data) {
    // Mirror unavailable or never seeded — say so rather than showing a fake 0-day streak.
    return <OfflineUnavailable title="Streak" />;
  }

  if (!data) {
    // Request failed: say we don't know rather than "no budget" or a fake 0-day streak (NN-09).
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Streak</h3>
        <p className="text-sm text-text-muted m-0">Couldn't load your budget, so the streak is unknown.</p>
        <button type="button" onClick={refetch} className="inline-block text-xs text-green hover:underline mt-2 min-h-6 min-w-6">
          Retry
        </button>
      </div>
    );
  }

  if (budgetStatus(data) === 'none') {
    // No budget total, so "0 days under budget" would be a verdict against nothing (NN-09).
    return (
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Streak</h3>
        <p className="text-sm text-text-muted m-0">No budget set, so there is no streak to count.</p>
        <a href={tabHash(urlState, 'goals')} className="inline-block text-xs text-green hover:underline mt-2">
          Set a budget to track this
        </a>
      </div>
    );
  }

  const current = data?.current ?? 0;
  const longest = data?.longest ?? 0;
  const isActive = current > 0;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Streak</h3>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-bold" style={{ color: isActive ? '#22c55e' : '#71717a' }}>
          {current}
        </span>
        <span className={`text-sm ${isActive ? 'text-green' : 'text-text-muted'}`}>
          {current === 1 ? 'day' : 'days'} under budget
        </span>
      </div>
      <div className="text-xs text-text-muted mt-2">
        Personal best: <span className="text-text">{longest} days</span>
      </div>
    </div>
  );
}
