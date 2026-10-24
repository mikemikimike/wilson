import { describe, expect, test } from 'bun:test';
import { headerFiltersApply } from '../dashboard/ui/src/lib/headerFilters.js';
import { TAB_IDS } from '../dashboard/webmcp-session.js';

describe('header filters (#186)', () => {
  test('hidden on Chat and Settings, shown on every other tab', () => {
    expect(headerFiltersApply('chat')).toBe(false);
    expect(headerFiltersApply('settings')).toBe(false);
    for (const t of TAB_IDS.filter((t) => t !== 'chat' && t !== 'settings')) expect(headerFiltersApply(t)).toBe(true);
  });
});

describe('agent access badge copy (#186)', () => {
  test('the launcher tooltip says what it allows and that nothing is shared until granted', async () => {
    const src = await Bun.file(new URL('../dashboard/webmcp-bridge.ts', import.meta.url)).text();
    expect(src).toContain('Nothing is shared until you grant a tool here');
    expect(src).toContain("'Agent access is off. No agent can use any tool.'");
    // aria-label tracks the title so screen readers hear the off state too.
    expect(src).toContain("launcher.setAttribute?.('aria-label', hint)");
  });
});
