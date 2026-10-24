import { useEffect, useRef } from 'react';
import { TAB_IDS, type TabId } from '@webmcp-session';

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

export type { TabId };

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  const navRef = useRef<HTMLElement>(null);

  // On a phone the 10 tabs overflow the bar: keep the active one in view (inside the bar only; never scroll the page).
  useEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !btn || nav.scrollWidth <= nav.clientWidth) return;
    // Rects, not offsetLeft: offsetLeft is relative to the offsetParent, which is the body unless the nav is positioned.
    const nr = nav.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    nav.scrollLeft = Math.max(0, nav.scrollLeft + (br.left - nr.left) - (nav.clientWidth - br.width) / 2);
  }, [activeTab]);

  return (
    <nav
      ref={navRef}
      data-hscroll
      className="flex gap-0 bg-surface-raised border-b border-border px-2 sm:px-6 shrink-0 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TAB_IDS.map((id) => (
        <button
          key={id}
          onClick={() => onTabChange(id)}
          aria-current={activeTab === id ? 'page' : undefined}
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
  );
}
