import { useAppState } from '@/state';
import type { RangePreset } from '@/hooks/useDateRange';
import { headerFiltersApply } from '@/lib/headerFilters';
import type { Entity } from '@/types';

interface HeaderProps {
  activeTab: string;
  accounts: { id: number; name: string }[];
  categories: string[];
  entities: Entity[];
  monthLabel: string;
  preset: RangePreset;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectPreset: (p: RangePreset) => void;
}

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'ytd', label: 'YTD' },
  { id: 'year', label: 'Year' },
  { id: 'prev-year', label: 'Prev Year' },
];

export function Header({
  activeTab,
  accounts,
  categories,
  entities,
  monthLabel,
  preset,
  onPrevMonth,
  onNextMonth,
  onSelectPreset,
}: HeaderProps) {
  const { accountId, setAccountId, category, setCategory, entityId, setEntityId } = useAppState();

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-6 py-3 bg-surface-raised border-b border-border shrink-0">
      <h1 className="text-lg font-semibold text-text">
        <span className="text-green">$</span> Wilson
      </h1>

      {headerFiltersApply(activeTab) && (
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
        {/* Preset pills */}
        <div className="flex flex-wrap items-center gap-0.5 bg-surface border border-border rounded-md p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelectPreset(p.id)}
              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer border-none transition-colors ${
                preset === p.id
                  ? 'bg-green/20 text-green'
                  : 'bg-transparent text-text-muted hover:text-text'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Prev / label / Next */}
        <div className="flex items-center gap-1">
          <button
            onClick={onPrevMonth}
            className="shrink-0 px-2 py-1 min-w-6 min-h-6 text-text-muted hover:text-text bg-transparent border border-border rounded cursor-pointer"
          >
            &larr;
          </button>
          <span className="text-sm text-text min-w-[110px] sm:min-w-[130px] text-center font-medium">
            {monthLabel}
          </span>
          <button
            onClick={onNextMonth}
            className="shrink-0 px-2 py-1 min-w-6 min-h-6 text-text-muted hover:text-text bg-transparent border border-border rounded cursor-pointer"
          >
            &rarr;
          </button>
        </div>

        {/* Phone: a fixed 3-column row, so the entity select appearing after /api/entities loads fills its own cell instead of wrapping onto a new row (layout shift). sm+: contents, so the selects flow with the controls as before. */}
        <div className="grid grid-cols-3 gap-2 w-full sm:contents">
        <select
          value={accountId ?? ''}
          onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
          className="bg-border-muted text-text border border-border px-2.5 py-1.5 rounded-md text-sm max-sm:w-full max-sm:min-w-0"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value || null)}
          className="bg-border-muted text-text border border-border px-2.5 py-1.5 rounded-md text-sm max-sm:w-full max-sm:min-w-0"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        {entities.length > 1 && (
          <select
            value={entityId ?? ''}
            onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : null)}
            className="bg-border-muted text-text border border-border px-2.5 py-1.5 rounded-md text-sm max-sm:w-full max-sm:min-w-0"
          >
            <option value="">All entities</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        </div>
      </div>
      )}
    </header>
  );
}
