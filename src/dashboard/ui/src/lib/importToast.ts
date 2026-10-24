/**
 * The confirmation shown after "Import to database" succeeds. Pure text from the counts the import API returned,
 * nothing is estimated or defaulted (NN-09).
 */
export interface ImportCounts {
  transactionsImported: number;
  transactionsSkipped: number;
}

export interface ImportToastModel {
  message: string;
  /** Rows were added, so "View" has something to show. */
  hasNew: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function importToastModel(counts: ImportCounts): ImportToastModel {
  const imported = Math.max(0, counts.transactionsImported);
  const skipped = Math.max(0, counts.transactionsSkipped);
  const skippedText = skipped > 0 ? `${plural(skipped, 'duplicate', 'duplicates')} skipped` : '';
  if (imported === 0) {
    return { message: skipped > 0 ? `No new transactions imported (${skippedText})` : 'No new transactions imported', hasNew: false };
  }
  const base = `${plural(imported, 'transaction', 'transactions')} imported`;
  return { message: skippedText ? `${base} (${skippedText})` : base, hasNew: true };
}

/** How long the import toast and the Transactions tab's import banner stay up before hiding themselves. */
export const IMPORT_NOTICE_AUTO_DISMISS_MS = 10_000;

/** The parts of POST /api/import's answer the Transactions tab's banner reads (cf. ImportResponse). */
export interface ImportBannerInput extends ImportCounts {
  status: 'imported' | 'skipped' | 'failed';
  message: string;
  previouslyImported?: { importedAt: string; transactionCount: number | null };
}

export interface ImportBannerModel {
  /** 'success' only when rows were actually added; a re-import that added nothing is 'neutral' (#201). */
  tone: 'success' | 'neutral';
  message: string;
}

/** The banner after an import: success styling only for rows that were added, and copy from the API's own counts. */
export function importBannerModel(result: ImportBannerInput): ImportBannerModel {
  const imported = Math.max(0, result.transactionsImported);
  if (result.status === 'imported' && imported > 0) return { tone: 'success', message: result.message };
  if (result.previouslyImported) {
    // The ledger's own date (SQLite "YYYY-MM-DD HH:MM:SS"); the day is enough here.
    const day = result.previouslyImported.importedAt.slice(0, 10);
    return { tone: 'neutral', message: `No new transactions — this file was already imported${day ? ` on ${day}` : ''}.` };
  }
  const skipped = Math.max(0, result.transactionsSkipped);
  if (skipped > 0) {
    return {
      tone: 'neutral',
      message: `No new transactions — ${skipped === 1 ? 'the 1 transaction in this file was' : `all ${plural(skipped, 'transaction', 'transactions')} in this file were`} already imported.`,
    };
  }
  return { tone: 'neutral', message: 'No new transactions imported.' };
}

// A tiny module store so the toast survives the importing tab unmounting when "View" switches tabs.
export interface ToastState {
  id: number;
  model: ImportToastModel;
}
let current: ToastState | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function showImportToast(counts: ImportCounts): void {
  current = { id: ++seq, model: importToastModel(counts) };
  for (const l of listeners) l();
}
export function dismissImportToast(): void {
  if (!current) return;
  current = null;
  for (const l of listeners) l();
}
export function subscribeImportToast(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getImportToast(): ToastState | null {
  return current;
}
