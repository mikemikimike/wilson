import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api';

/**
 * Whether Wilson's own Chat may use the user's data: the Agent access switch, as GET /api/chat/access reports it.
 * Read on mount and again whenever the tab regains focus (the switch lives in Settings, another tab, or another
 * window), so the Chat tab shows its notice before anything is sent. `null` until the first answer; a failed read
 * keeps the last known value (the server enforces the switch on every turn either way). `setOff` records an
 * access-off reply from POST /api/chat at once.
 */
export function useChatAgentAccess(): { agentAccess: boolean | null; refresh: () => void; setOff: () => void } {
  const [agentAccess, setAgentAccess] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    void api<{ agentAccess?: boolean }>('/api/chat/access')
      .then((res) => setAgentAccess(res?.agentAccess !== false))
      .catch(() => {
        // offline or signed out: keep what we knew
      });
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const setOff = useCallback(() => setAgentAccess(false), []);
  return { agentAccess, refresh, setOff };
}
