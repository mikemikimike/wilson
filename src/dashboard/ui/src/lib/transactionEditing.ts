/**
 * Who may edit transactions by hand, and what the Transactions tab's inline pickers and the importer's entry
 * points show (pure, unit-tested). #184 category picker, #187 account picker + first-import call to action,
 * #190 the admin-only import entry.
 *
 * The server is the gate (canWrite on PATCH /api/transactions/:id and POST /api/import, NN-04); these only decide
 * what a person is offered, so a viewer is told before doing the work instead of after.
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */
import { categoryOptionLabel } from '../../../declarative-submit-core.js';
import { isUncategorized } from '../../../../db/spend-rules.js';

/** The fields of GET /api/auth/status these helpers read. */
export interface WriteAuthStatus {
  authEnabled: boolean;
  user: { role: string } | null;
}

/**
 * Whether to offer write controls (mirrors the server's canWrite: auth off, or an admin). While the status is still
 * loading (null) nothing is offered, so a viewer never sees an editor flash up.
 */
export function canEditTransactions(auth: WriteAuthStatus | null | undefined): boolean {
  if (!auth) return false;
  if (!auth.authEnabled) return true;
  return auth.user?.role === 'admin';
}

/** Whether the status says, for sure, that this person may not write (auth on and not an admin). */
export function isKnownReadOnly(auth: WriteAuthStatus | null | undefined): boolean {
  return !!auth && !canEditTransactions(auth);
}

export const IMPORT_ADMIN_ONLY_TITLE =
  'Importing is admin-only. Ask your household admin to import this statement, or to give you an admin account.';

export interface ImportEntry {
  disabled: boolean;
  label: string;
  /** Tooltip; present only when the entry is disabled. */
  title?: string;
}

/**
 * The "Import statement" entry button. Disabled and relabelled only once the status says this person is read-only,
 * so an admin never sees it disabled while the status loads.
 */
export function importEntry(auth: WriteAuthStatus | null | undefined, label = 'Import statement'): ImportEntry {
  if (isKnownReadOnly(auth)) return { disabled: true, label: 'Import (admin only)', title: IMPORT_ADMIN_ONLY_TITLE };
  return { disabled: false, label };
}

export interface DateRangeLike {
  startDate: string;
  endDate: string;
}

/**
 * The date range to switch to after an import, or null to keep the current one: only when rows were imported and
 * the current range doesn't cover them (ISO dates compare as strings), so fresh rows aren't hidden.
 */
export function rangeCoveringImport(
  current: DateRangeLike,
  result: { transactionsImported: number; dateRange?: { start: string; end: string } },
): DateRangeLike | null {
  if (result.transactionsImported <= 0 || !result.dateRange) return null;
  const { start, end } = result.dateRange;
  if (current.startDate <= start && current.endDate >= end) return null;
  return { startDate: start, endDate: end };
}

/**
 * The Account cell's text: the linked account's name when the row has one (the picker sets `account_id`), else
 * the account name the statement carried, else null ('--').
 */
export function accountCellLabel(
  tx: { account_id: number | null; account_name: string | null },
  accounts: ReadonlyArray<{ id: number; name: string }>,
): string | null {
  if (tx.account_id != null) {
    const linked = accounts.find((a) => a.id === tx.account_id);
    if (linked) return linked.name;
  }
  return tx.account_name ?? null;
}

export interface PickerOption {
  value: string;
  label: string;
}

/**
 * The inline category picker's options: every category by NAME (what PATCH takes), labelled the safe way the
 * filter labels them. A row's current category that is not in the list (a bank-supplied one) stays selectable
 * so the select shows it rather than silently showing another value. Uncategorized is the picker's '' option
 * (`categoryPickerValue`), never one of these.
 */
export function categoryPickerOptions(
  rows: ReadonlyArray<{ id: number; name: string; is_system: number | boolean }>,
  current: string | null,
): PickerOption[] {
  const options = rows.map((row) => ({ value: row.name, label: categoryOptionLabel(row) }));
  if (current && !isUncategorized(current) && !rows.some((r) => r.name === current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

/** The picker's value for a row: '' (the Uncategorized option) for a NULL, blank or 'Uncategorized' category. */
export function categoryPickerValue(category: string | null | undefined): string {
  return isUncategorized(category) ? '' : category!;
}

/**
 * The PATCH body the category picker sends. A person picking a category has verified it; picking Uncategorized
 * ('') clears the category and the verified flag, so the row goes back to the categorize queue (#200).
 */
export function categoryPatchBody(category: string): { category: string; user_verified: 1 } | { category: null; user_verified: 0 } {
  return category === '' ? { category: null, user_verified: 0 } : { category, user_verified: 1 };
}

/** The PATCH body the account picker sends ('' is the "--" choice: unlink). */
export function accountPatchBody(value: string): { account_id: number | null } {
  return { account_id: value === '' ? null : Number(value) };
}
