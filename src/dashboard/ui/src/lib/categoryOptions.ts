/**
 * The one category list both category filters use (pure, unit-tested; #200).
 *
 * Built from GET /api/categories (every category row, with ids) plus GET
 * /api/category-options (every label present in transactions, including
 * non-spend ones like Transfer and bank-supplied labels with no category row).
 * NOT from /api/summary: the summary applies the dashboard SPEND rule, so
 * non-spend categories would vanish as filter options.
 *
 * Uncategorized is always the first choice. On the server it matches a NULL,
 * blank or 'Uncategorized' category (DASHBOARD_RULES.uncategorizedMatchesBlank),
 * and `matchesCategoryFilter` applies the same rule in the page.
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */
import { categoryOptionLabel } from '../../../declarative-submit-core.js';
import { isUncategorized, UNCATEGORIZED_LABEL } from '../../../../db/spend-rules.js';

export { UNCATEGORIZED_LABEL };

/**
 * The id `fill_transaction_filters` takes for the Uncategorized choice: real category ids are positive, so 0 can never
 * name one.
 */
export const UNCATEGORIZED_FILTER_ID = 0;

export interface CategoryChoice {
  /** What the filter matches: a category name, or UNCATEGORIZED_LABEL. */
  name: string;
  /** The category row's id, UNCATEGORIZED_FILTER_ID for Uncategorized, null for a label only transactions carry. */
  id: number | null;
  /** The option text: a custom category that fails the safe-label rule shows as `#<id> (custom)`. */
  label: string;
}

/**
 * Uncategorized first, then every category row and every transaction label, by name, de-duplicated. A deep-linked
 * `selected` category is always present so the dropdown shows it as selected even before (or without) the lists
 * that would name it.
 */
export function categoryChoices(
  rows: ReadonlyArray<{ id: number; name: string; is_system: number | boolean }> | null | undefined,
  labels: readonly string[] | null | undefined,
  selected: string | null = null,
): CategoryChoice[] {
  const byName = new Map<string, CategoryChoice>();
  for (const row of rows ?? []) {
    if (typeof row.name !== 'string' || row.name === '' || row.name === UNCATEGORIZED_LABEL) continue;
    if (!byName.has(row.name)) byName.set(row.name, { name: row.name, id: row.id, label: categoryOptionLabel(row) });
  }
  for (const name of [...(labels ?? []), ...(selected ? [selected] : [])]) {
    if (typeof name !== 'string' || name === '' || name === UNCATEGORIZED_LABEL || byName.has(name)) continue;
    byName.set(name, { name, id: null, label: name });
  }
  const rest = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [{ name: UNCATEGORIZED_LABEL, id: UNCATEGORIZED_FILTER_ID, label: UNCATEGORIZED_LABEL }, ...rest];
}

/** True when a row's stored category passes the filter ('' is all). Uncategorized matches NULL, blank or the label. */
export function matchesCategoryFilter(category: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  if (filter === UNCATEGORIZED_LABEL) return isUncategorized(category);
  return category === filter;
}
