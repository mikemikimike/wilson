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
