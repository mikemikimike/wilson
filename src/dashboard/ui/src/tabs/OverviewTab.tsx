import { lazy, Suspense, useState } from 'react';
import { WeeklySummary } from '@/components/WeeklySummary';
import { SpendingHeatmap } from '@/components/SpendingHeatmap';
import { StreakCounter } from '@/components/StreakCounter';
import { BudgetCountdown } from '@/components/BudgetCountdown';
import { SavingsSparkline } from '@/components/SavingsSparkline';
import { CashflowForecast } from '@/components/CashflowForecast';
import { SpendingDrill } from '@/components/spending/SpendingDrill';
import { FilteredBadge } from '@/components/FilteredBadge';
import { PnlCard } from '@/components/PnlCard';
import { BudgetBars } from '@/components/BudgetBars';
import { AlertList } from '@/components/AlertList';
import { LiabilitiesCard } from '@/components/LiabilitiesCard';
import { Dialog } from '@/components/Dialog';
import { useApi } from '@/hooks/useApi';
import { useMirrorStatus } from '@/hooks/useMirrorSync';
import { useUrlState } from '@/hooks/useUrlState';
import { useAppState } from '@/state';
import { dayTransactionsPath, daySpendTotal } from '@/lib/overviewQueries';
import { money } from '@/format';
import { importEntry, rangeCoveringImport, type WriteAuthStatus } from '@/lib/transactionEditing';
import { showImportToast } from '@/lib/importToast';
import type { ImportResponse } from '@/components/ImportStatementDialog';
import type { Transaction } from '@/types';

// The importer (and the statement parsers it pulls in) loads only when someone opens it, so Overview's first paint
// doesn't pay for it (NN-10).
const ImportStatementDialog = lazy(() =>
  import('@/components/ImportStatementDialog').then((m) => ({ default: m.ImportStatementDialog })),
);

/**
 * First-run call to action (#187): with no transactions at all, Overview's cards are empty, so the first thing it
 * offers is the importer. A viewer is told up front that importing is the admin's job (#190).
 */
function FirstImportCta({ auth, onImport }: { auth: WriteAuthStatus | null; onImport: () => void }) {
  const entry = importEntry(auth, 'Import your first statement');
  return (
    <section
      aria-labelledby="first-import-heading"
      className="bg-surface-raised border border-green/40 rounded-lg p-6 flex items-center justify-between gap-6 flex-wrap"
    >
      <div className="min-w-0 space-y-1">
        <h2 id="first-import-heading" className="text-base font-semibold text-text">
          No transactions yet
        </h2>
        <p className="text-sm text-text-secondary">
          {entry.disabled
            ? entry.title
            : 'Import a CSV, OFX or QIF statement to fill in this overview. It is parsed in your browser, and nothing is saved until you confirm.'}
        </p>
      </div>
      <span title={entry.title}>
        <button
          onClick={onImport}
          disabled={entry.disabled}
          className="bg-green-700 hover:bg-green-600 disabled:bg-surface disabled:text-text-muted disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors cursor-pointer border-none whitespace-nowrap"
        >
          {entry.label}
        </button>
      </span>
    </section>
  );
}

export function OverviewTab() {
  // The open day dialog lives in the URL (`day=YYYY-MM-DD`) so it survives a
  // reload and can be linked.
  const { state: url, navigate } = useUrlState();
  const selectedDate = url.day;
  const setSelectedDate = (day: string | null) => navigate((s) => ({ ...s, day }), { mode: 'replace' });
  const { accountId, entityId, category, dateRange, setDateRange } = useAppState();
  const mirror = useMirrorStatus();

  // Any transaction at all? Unfiltered on purpose: the call to action is for an empty profile, not an empty filter.
  const { data: anyTransaction, refetch: refetchAny } = useApi<Transaction[]>('/api/transactions?limit=1');
  const isEmpty = anyTransaction != null && anyTransaction.length === 0;
  const { data: authStatus } = useApi<WriteAuthStatus>(isEmpty ? '/api/auth/status' : null, [isEmpty]);
  const [importOpen, setImportOpen] = useState(false);
  const [importMounted, setImportMounted] = useState(false);
  // Bumped after an import so every card refetches (they fetch on mount).
  const [cardsKey, setCardsKey] = useState(0);

  function openImporter() {
    setImportMounted(true);
    setImportOpen(true);
  }

  function handleImported(result: ImportResponse) {
    setImportOpen(false);
    const range = rangeCoveringImport(dateRange, result);
    if (range) setDateRange(range);
    refetchAny();
    showImportToast(result);
    setCardsKey((k) => k + 1);
  }

  // Only fetch while a day is open (null path = skip), scoped to the same
  // header filters as the heatmap so the dialog total matches the cell.
  const dayPath = dayTransactionsPath(selectedDate, { accountId, entityId, category });
  const { data: dayTransactions, loading: dayLoading } = useApi<Transaction[]>(dayPath);

  const dayTotal = daySpendTotal(dayTransactions ?? []);

  return (
    // pb-20: a safe area under the last row so the floating 'Agent access'
    // pill (fixed bottom-left, webmcp-bridge.ts) never covers card footnotes.
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 pb-20 space-y-4">
      {/* Offline pill — same affordance as the transactions tab */}
      {mirror.available && mirror.seeded && !mirror.online && (
        <div className="flex items-center gap-2">
          <span
            data-testid="offline-pill"
            className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-500 uppercase tracking-wide"
          >
            Offline — showing synced data
          </span>
        </div>
      )}

      {isEmpty && <FirstImportCta auth={authStatus} onImport={openImporter} />}

      <div key={cardsKey} className="space-y-4">
        {/* Weekly narrative */}
        <WeeklySummary />

        {/* Heatmap + Streak */}
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_240px] gap-4">
          <SpendingHeatmap onDayClick={(date) => setSelectedDate(date)} />
          <StreakCounter />
        </div>

        {/* Budget countdown + Savings sparkline + Cash forecast */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BudgetCountdown />
          <SavingsSparkline />
          <CashflowForecast />
        </div>

        {/* Spending drill-down (L1 categories → L2 merchants → L3 merchant → txn) + P&L */}
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start">
          <SpendingDrill />
          <PnlCard />
        </div>

        {/* Budget bars + Alerts + Liabilities */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BudgetBars />
          <AlertList />
          <LiabilitiesCard />
        </div>
      </div>

      {importMounted && (
        <Suspense fallback={null}>
          <ImportStatementDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={handleImported} />
        </Suspense>
      )}

      {/* Day-click detail modal */}
      <Dialog
        open={selectedDate !== null}
        onClose={() => setSelectedDate(null)}
        title={selectedDate ?? ''}
      >
        {category && (
          <div className="mb-3">
            <FilteredBadge category={category} />
          </div>
        )}
        {dayLoading ? (
          <p className="text-text-secondary text-sm">Loading...</p>
        ) : !dayTransactions || dayTransactions.length === 0 ? (
          <p className="text-text-secondary text-sm">No transactions on this day.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {dayTransactions.map((txn) => (
                <li
                  key={txn.id}
                  className="flex items-center justify-between bg-surface-raised border border-border rounded px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-text text-sm truncate">
                      {txn.merchant_name ?? txn.description}
                    </p>
                    {txn.category && (
                      <p className="text-text-secondary text-xs">{txn.category}</p>
                    )}
                  </div>
                  <span
                    className={`ml-4 text-sm font-medium whitespace-nowrap tabular-nums ${
                      txn.amount < 0 ? 'text-red' : 'text-green'
                    }`}
                  >
                    {txn.amount > 0 ? '+' : ''}
                    {money(txn.amount)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
              <span className="text-text-secondary text-sm">Total spending</span>
              <span className="text-red text-sm font-semibold tabular-nums">
                {money(-dayTotal)}
              </span>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
