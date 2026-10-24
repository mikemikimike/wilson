/**
 * Tabs where the header's period, account, category and entity filters change nothing (#186). Chat answers from its own
 * request and Settings is configuration; neither reads dateRange/accountId/category/entityId (see ChatTab, SettingsTab).
 * Showing controls that do nothing makes a first-time visitor wonder what they are scoping.
 */
const TABS_WITHOUT_FILTERS: ReadonlySet<string> = new Set(['chat', 'settings']);

export function headerFiltersApply(tab: string): boolean {
  return !TABS_WITHOUT_FILTERS.has(tab);
}
