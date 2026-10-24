import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards for the phone layout (issue #180, NN-10 layoutAt360). The real check is the e2e layout audit
 * (`bun run e2e`); these keep the structural fixes from being quietly undone.
 */
const UI = join(import.meta.dir, '../dashboard/ui/src');
const read = (p: string) => readFileSync(join(UI, p), 'utf8');

describe('phone layout source guards (#180)', () => {
  test('the tab bar scrolls sideways and keeps its tabs at natural width', () => {
    const src = read('components/TabBar.tsx');
    expect(src).toContain('overflow-x-auto');
    expect(src).toContain('shrink-0 whitespace-nowrap');
    expect(src).toContain('aria-current');
  });

  test('the tab bar shows scroll-aware edge fades and keyboard/touch-reachable hints (#186)', () => {
    const src = read('components/TabBar.tsx');
    expect(src).toContain('data-hscroll');
    expect(src).toContain('pointer-events-none');
    expect(src).toContain("addEventListener('scroll', measure");
    for (const id of ['llm', 'logs', 'settings']) expect(src).toMatch(new RegExp(`\\n  ${id}: '`));
    expect(src).toContain('onFocus');
    expect(src).toContain("pointerType === 'touch'");
    expect(read('components/agent/KillSwitch.tsx')).toContain('aria-describedby="agent-kill-switch-hint"');
  });

  test('the app root no longer clips horizontal overflow', () => {
    expect(read('App.tsx')).not.toMatch(/h-screen flex flex-col[^"]*overflow-hidden/);
    const css = read('styles/app.css');
    const start = css.indexOf('#root {');
    const root = css.slice(start, css.indexOf('}', start));
    expect(root).not.toMatch(/overflow\s*:\s*hidden/);
  });

  test('every Overview grid stacks to one column below md', () => {
    const src = read('tabs/OverviewTab.tsx');
    const grids = src.match(/className="grid [^"]*"/g) ?? [];
    expect(grids.length).toBeGreaterThanOrEqual(4);
    for (const g of grids) expect(g).toContain('grid-cols-1');
  });

  test('the header wraps instead of overflowing', () => {
    expect(read('components/Header.tsx')).toContain('flex-wrap');
  });

  test('the layout audit reports truncation explicitly', () => {
    const LAYOUT_AUDIT_JS = readFileSync(join(import.meta.dir, '../../e2e/lib/page.mjs'), 'utf8');
    expect(LAYOUT_AUDIT_JS).toContain('truncated: offenders.length > LIMIT');
    expect(LAYOUT_AUDIT_JS).toContain('total: offenders.length');
  });

  test('the AGENT ACCESS launcher collapses on phones and the panel fits the viewport', () => {
    const src = readFileSync(join(import.meta.dir, '../dashboard/webmcp-bridge.ts'), 'utf8');
    expect(src).toContain("matchMedia('(max-width: 640px)')");
    expect(src).toContain('width:min(300px,calc(100vw - 32px))');
  });

  // CLS (NN-10): stacking the Overview into one column makes every card's loaded height differ from its desktop
  // skeleton. Each skeleton must reserve its phone height by CSS (reactive to resize/rotation), not a JS check.
  test('Overview skeletons reserve their phone height with a responsive class', () => {
    const skeletons: Record<string, RegExp> = {
      'components/WeeklySummary.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/StreakCounter.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/BudgetCountdown.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/CashflowForecast.tsx': /h-\[\d+px\] md:h-\[\d+px\](?: xl:h-\[\d+px\])? animate-pulse/,
      'components/PnlCard.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/AlertList.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/LiabilitiesCard.tsx': /h-\[\d+px\] md:h-\[\d+px\] animate-pulse/,
      'components/SpendingHeatmap.tsx': /heightClass="h-\[\d+px\] md:h-\[\d+px\]"/,
      'components/SavingsSparkline.tsx': /heightClass="h-\[\d+px\] md:h-\[\d+px\]"/,
      'components/BudgetBars.tsx': /heightClass="h-\[\d+px\]"/,
      'components/spending/SpendingLevel1.tsx': /heightClass="h-\[\d+px\] md:h-\[\d+px\]"/,
    };
    for (const [file, re] of Object.entries(skeletons)) expect(read(file)).toMatch(re);
    expect(read('components/SpendingHeatmap.tsx')).not.toContain('matchMedia');
    expect(read('charts/ChartCard.tsx')).toContain('heightClass');
    // A keyed skeleton root is remounted, not reused as the loaded header row (Chrome reported that reuse as a shift).
    expect(read('components/PnlCard.tsx')).toContain('key="pnl-skeleton"');
  });

  test('late-arriving header/title controls cannot wrap onto a new row', () => {
    // Entity select (appears once /api/entities loads) sits in a fixed 3-column phone row.
    expect(read('components/Header.tsx')).toContain('grid grid-cols-3 gap-2 w-full sm:contents');
    // The Transactions count group is flex-1 beside the Import button, so the count text never wraps it.
    expect(read('tabs/TransactionsTab.tsx')).toContain('min-w-0 max-sm:flex-1');
  });
});
