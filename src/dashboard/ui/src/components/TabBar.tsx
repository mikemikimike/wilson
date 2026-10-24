import { useCallback, useEffect, useRef, useState } from 'react';
import { TAB_IDS, type TabId } from '@webmcp-session';
import { SETTINGS_TAB_HINT } from '@/lib/agentAccessCopy';

// The ids live in one place (TAB_IDS, shared with the server's tab-scoped tools); only the labels are here.
const TAB_LABELS: Record<TabId, string> = {
  overview: 'Overview',
  transactions: 'Transactions',
  review: 'Review',
  accounts: 'Accounts',
  goals: 'Goals',
  forecast: 'Forecast',
  chat: 'Chat',
  llm: 'LLM',
  logs: 'Logs',
  settings: 'Settings',
};

// One honest sentence for the tabs whose names do not say what they hold. Shown on hover, keyboard focus and touch
// (a title attribute alone never appears on a phone). Settings carries the Agent access switch.
const TAB_HINTS: Partial<Record<TabId, string>> = {
  llm: 'Every model call Wilson has made, with its prompt, response and cost, for you to review and rate.',
  logs: 'The dashboard server log, for diagnosing problems.',
  settings: SETTINGS_TAB_HINT,
};

export type { TabId };

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  const navRef = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ start: false, end: false });
  const [tip, setTip] = useState<TabId | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Scroll-position-aware cue: a fade on an edge only while tabs are hidden past it.
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const start = nav.scrollLeft > 1;
    const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
    setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    measure();
    nav.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      nav.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => () => clearTimeout(tipTimer.current), []);

  const showTip = (id: TabId, autoHide = false) => {
    clearTimeout(tipTimer.current);
    setTip(TAB_HINTS[id] ? id : null);
    if (autoHide) tipTimer.current = setTimeout(() => setTip(null), 4000);
  };
  const hideTip = () => {
    clearTimeout(tipTimer.current);
    setTip(null);
  };

  // On a phone the 10 tabs overflow the bar: keep the active one in view (inside the bar only; never scroll the page).
  useEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !btn || nav.scrollWidth <= nav.clientWidth) return;
    // Rects, not offsetLeft: offsetLeft is relative to the offsetParent, which is the body unless the nav is positioned.
    const nr = nav.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    nav.scrollLeft = Math.max(0, nav.scrollLeft + (br.left - nr.left) - (nav.clientWidth - br.width) / 2);
    measure();
  }, [activeTab, measure]);

  const fade = 'absolute top-0 bottom-0 w-8 pointer-events-none transition-opacity duration-150 sm:hidden';

  return (
    <div className="relative shrink-0" onKeyDown={(e) => e.key === 'Escape' && hideTip()}>
      <nav
        ref={navRef}
        data-hscroll
        className="flex gap-0 bg-surface-raised border-b border-border px-2 sm:px-6 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TAB_IDS.map((id) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            onMouseEnter={() => showTip(id)}
            onMouseLeave={hideTip}
            onFocus={() => showTip(id)}
            onBlur={hideTip}
            onPointerDown={(e) => e.pointerType === 'touch' && showTip(id, true)}
            aria-current={activeTab === id ? 'page' : undefined}
            aria-describedby={TAB_HINTS[id] ? `tabhint-${id}` : undefined}
            className={`shrink-0 whitespace-nowrap px-3 sm:px-5 py-2.5 bg-transparent border-none text-sm font-medium cursor-pointer border-b-2 transition-all duration-150 ${
              activeTab === id
                ? 'text-text border-b-green'
                : 'text-text-secondary border-b-transparent hover:text-text'
            }`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>
      <div
        aria-hidden="true"
        data-testid="tabbar-fade-start"
        className={`${fade} left-0 bg-gradient-to-r from-surface-raised to-transparent ${more.start ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        data-testid="tabbar-fade-end"
        className={`${fade} right-0 bg-gradient-to-l from-surface-raised to-transparent ${more.end ? 'opacity-100' : 'opacity-0'}`}
      />
      {(Object.keys(TAB_HINTS) as TabId[]).map((id) => (
        <span key={id} id={`tabhint-${id}`} role={tip === id ? 'tooltip' : undefined} className={tip === id ? 'absolute left-2 right-2 sm:left-6 top-full mt-1 z-30 rounded border border-border bg-surface-raised px-3 py-2 text-xs text-text-secondary shadow-lg pointer-events-none' : 'sr-only'}>
          {TAB_HINTS[id]}
        </span>
      ))}
    </div>
  );
}
