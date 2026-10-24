import { useEffect, useSyncExternalStore } from 'react';
import { navigateToTab } from '@/hooks/useUrlState';
import { dismissImportToast, getImportToast, subscribeImportToast } from '@/lib/importToast';

const AUTO_DISMISS_MS = 10_000;

/**
 * Fixed overlay (no layout shift) shown after an import. Sits above the bottom-left 'Agent access' launcher
 * (bottom 16px, ~34px tall) and spans the width on a phone.
 */
export function ImportToast() {
  const toast = useSyncExternalStore(subscribeImportToast, getImportToast, () => null);
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return;
    const t = setTimeout(dismissImportToast, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [id]);
  if (!toast) return null;
  return (
    <div
      role="status"
      data-testid="import-toast"
      className="fixed z-40 bottom-16 left-3 right-3 sm:left-4 sm:right-auto sm:w-96 flex items-center gap-3 rounded-md border border-green-700/50 bg-surface px-3 py-2 text-sm text-text shadow-lg"
    >
      <span className="min-w-0 flex-1 break-words">{toast.model.message}</span>
      {toast.model.hasNew && (
        <button
          type="button"
          onClick={() => {
            navigateToTab('transactions');
            dismissImportToast();
          }}
          className="shrink-0 bg-transparent border-none p-0 text-green hover:underline cursor-pointer text-sm"
        >
          View
        </button>
      )}
      <button
        type="button"
        onClick={dismissImportToast}
        aria-label="Dismiss"
        className="shrink-0 bg-transparent border-none text-text-muted hover:text-text text-base cursor-pointer"
      >
        &times;
      </button>
    </div>
  );
}
