import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authedFetch, getBaseUrl } from '@/api';
import { hybridOptsForOriginFetch } from '@/hybrid/init-opts';
import type { HybridResult } from '@/hybrid/core';
import type { PriorLocalTurn } from '@/hybrid/worker-protocol';
import type {
  WilsonHybridChatGlobal,
  CategorizeSampleResult,
  CategorizeSampleOpts,
  InTabModelStatus,
} from '@/hybrid/standalone';
import {
  fetchActiveMirrorProfile,
  getMirrorState,
  openToolPort,
  syncMirror,
} from '@/store/mirror-client';
import { mirrorStatusViaPort, prepareMirrorForRun } from '@/store/mirror-subagent';
import { chooseToolWithHost } from '@/openjev/choose-tool';
import { getOpenJevHost } from '@/openjev/instance';
import type { LocalChatConfigResponse } from '@/hybrid/client';
import {
  browserLocalStorage,
  clearInTabOptIn,
  isInTabOptedIn,
  setInTabOptIn,
  tryLocalIfOptedIn,
} from '@/hybrid/consent';

/**
 * React binding for the prebuilt hybrid chat chunk (/assets/hybrid-chat.js).
 *
 * The chunk (and transformers.js inside it) is loaded at runtime via a
 * dynamic import of a variable URL — the inline @vite-ignore comment keeps it
 * OUT of the React app bundle. A missing chunk (hybrid build not
 * present) resolves to null → "unavailable", never a throw: the caller falls
 * back to the server path silently.
 */

type ChunkStatus = 'unknown' | 'available' | 'unavailable';

let chunkPromise: Promise<WilsonHybridChatGlobal | null> | null = null;

/** Per-turn options ChatTab passes to tryLocal (the browser subagent). */
export interface TryLocalExtras {
  /** Turns answered on-device earlier in this session, most recent last. */
  priorLocalTurns?: PriorLocalTurn[];
}

/**
 * Dev-only: `localStorage['wilson-subagent-debug']==='1'` exposes
 * `window.__wilsonDebug.mirrorStatus()`, which opens a tool port and sends
 * `status` (live-Chrome verification, specs/browser-subagent.md section 14).
 */
function installDebugHelper(): void {
  try {
    if (localStorage.getItem('wilson-subagent-debug') !== '1') return;
    const w = window as unknown as { __wilsonDebug?: Record<string, unknown> };
    w.__wilsonDebug = {
      ...(w.__wilsonDebug ?? {}),
      mirrorStatus: () => mirrorStatusViaPort(() => openToolPort()),
    };
  } catch {
    // storage unavailable: no debug helper, nothing else changes
  }
}

function loadHybridChunk(baseUrl: string): Promise<WilsonHybridChatGlobal | null> {
  chunkPromise ??= (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ `${baseUrl}/assets/hybrid-chat.js`)) as {
        WilsonHybridChat?: WilsonHybridChatGlobal;
      };
      return mod?.WilsonHybridChat ?? window.WilsonHybridChat ?? null;
    } catch {
      // 404 (hybrid not built) or a load error → capability-unavailable.
      return null;
    }
  })();
  return chunkPromise;
}

/** Whether this browser exposes WebGPU at all (sync, so Chat can reserve the opt-in's space on first paint). */
function hasWebGPU(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu;
  } catch {
    return false;
  }
}

const DISMISS_KEY = 'wilson-intab-chat-optin-dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The Chat opt-in for the in-tab model (NN-01: its weights come from
 * huggingface.co, so nothing loads before this click). `offered` only where
 * the hybrid chunk is available, WebGPU exists, the server has local chat on
 * and localStorage works (the chunk re-reads the key on every turn).
 */
export interface InTabConsent {
  /** WebGPU present and nothing ruled the in-tab model out yet: Chat reserves the row. */
  reserve: boolean;
  offered: boolean;
  optedIn: boolean;
  /** "Not now" for this tab session. */
  dismissed: boolean;
  /** Catalog size, raw ('~3.6GB'). */
  downloadSize: string | null;
  /** The server's chat model id (who answers until the in-tab model is on). */
  serverModel: string | null;
  optIn(): void;
  optOut(): void;
  dismiss(): void;
}

export interface UseHybridChatResult {
  /** Local-first attempt; resolves {ok:false} on any hybrid failure. */
  tryLocal(
    query: string,
    onProgress?: (label: string) => void,
    sessionId?: string | null,
    extras?: TryLocalExtras,
  ): Promise<HybridResult>;
  /** Speed Showdown browser arm; resolves {ok:false, reason:'unavailable'} without a chunk. */
  categorizeSample(opts: CategorizeSampleOpts): Promise<CategorizeSampleResult>;
  /** Whether the hybrid chunk itself is loadable (not GPU capability). */
  status: ChunkStatus;
  /**
   * Always-current `status`, readable inside send closures where the React
   * `status` state can be stale. Updated the moment the chunk load resolves.
   */
  getStatus(): ChunkStatus;
  /** In-tab model status ('idle' until a turn starts the load; turns use the server until 'ready'). */
  modelStatus: InTabModelStatus;
  /** The opt-in the in-tab model needs before it may download (consent.ts). */
  consent: InTabConsent;
}

export function useHybridChat(): UseHybridChatResult {
  const [status, setStatus] = useState<ChunkStatus>('unknown');
  // Ref mirror of `status`: React state is stale inside handleSend closures,
  // so provenance derivation must read the ref via getStatus() instead.
  const statusRef = useRef<ChunkStatus>('unknown');
  // The chunk is configured exactly once per loaded instance — init() replaces
  // the internal client, which would drop an already-loaded model.
  const initedRef = useRef<WilsonHybridChatGlobal | null>(null);
  const [modelStatus, setModelStatus] = useState<InTabModelStatus>({ state: 'idle' });
  const [webgpu] = useState(hasWebGPU);
  // Same-origin config read: which model the consent is for, its size, and the server's model.
  const configRef = useRef<Promise<LocalChatConfigResponse | null> | null>(null);
  const [config, setConfig] = useState<LocalChatConfigResponse | null | undefined>(undefined);
  const [optedIn, setOptedIn] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  const loadConfig = useCallback((): Promise<LocalChatConfigResponse | null> => {
    configRef.current ??= api<LocalChatConfigResponse>('/api/config/local-chat')
      .then((cfg) => (cfg?.enabled && cfg.repo ? cfg : null))
      .catch(() => null);
    return configRef.current;
  }, []);

  const ensure = useCallback(async (): Promise<WilsonHybridChatGlobal | null> => {
    const base = getBaseUrl();
    const hybrid = await loadHybridChunk(base);
    if (hybrid && initedRef.current !== hybrid) {
      // authedFetch already prefixes the origin: baseUrl stays empty (see init-opts.ts).
      hybrid.init(hybridOptsForOriginFetch(authedFetch));
      initedRef.current = hybrid;
    }
    // Keep the ref accurate the moment any tryLocal resolves, independent of
    // re-renders.
    statusRef.current = hybrid ? 'available' : 'unavailable';
    return hybrid;
  }, []);

  useEffect(() => {
    installDebugHelper();
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void ensure().then((hybrid) => {
      if (!alive) return;
      setStatus(hybrid ? 'available' : 'unavailable');
      if (hybrid && webgpu) {
        void loadConfig().then((cfg) => {
          if (!alive) return;
          setConfig(cfg);
          setOptedIn(isInTabOptedIn(browserLocalStorage(), cfg?.repo));
        });
      } else {
        setConfig(null);
      }
      // An older chunk without the status API simply never shows a status line.
      unsubscribe = hybrid?.onModelStatus?.((next) => {
        if (alive) setModelStatus(next);
      });
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [ensure, loadConfig, webgpu]);

  const runLocal = useCallback(
    async (
      query: string,
      onProgress?: (label: string) => void,
      sessionId?: string | null,
      extras?: TryLocalExtras,
    ): Promise<HybridResult> => {
      const hybrid = await ensure();
      if (!hybrid) return { ok: false };
      // The mirror half of the browser subagent. Only invoked by the hybrid
      // chunk after the gate passed and only when the server enabled the flag,
      // so with the flag off nothing here ever runs.
      return hybrid.tryLocal(query, onProgress, sessionId, {
        subagent: {
          priorLocalTurns: extras?.priorLocalTurns ?? [],
          prepareMirror: () =>
            prepareMirrorForRun({
              getState: getMirrorState,
              syncMirror,
              fetchActiveProfile: fetchActiveMirrorProfile,
              openToolPort,
              now: () => Date.now(),
            }),
          // Round 4: the open-jev tiebreak. The hybrid chunk calls this only for a 0 / 2+ keyword-hit
          // question, with the server flag on and the cut frozen. It never prompts, downloads or waits.
          chooseTool: (req) => chooseToolWithHost(getOpenJevHost(), req),
        },
      });
    },
    [ensure],
  );

  const tryLocal = useCallback(
    async (
      query: string,
      onProgress?: (label: string) => void,
      sessionId?: string | null,
      extras?: TryLocalExtras,
    ): Promise<HybridResult> =>
      // NN-01: without the opt-in for this model the chunk is not even asked (it gates again itself).
      tryLocalIfOptedIn(
        async () => isInTabOptedIn(browserLocalStorage(), (await loadConfig())?.repo),
        () => runLocal(query, onProgress, sessionId, extras),
      ),
    [loadConfig, runLocal],
  );

  const categorizeSample = useCallback(
    async (opts: CategorizeSampleOpts): Promise<CategorizeSampleResult> => {
      const hybrid = await ensure();
      if (!hybrid) {
        return {
          ok: false,
          model: '',
          raw: '',
          decision: null,
          decisionMs: 0,
          loadMs: 0,
          loadFresh: false,
          reason: 'unavailable',
        };
      }
      return hybrid.categorizeSample(opts);
    },
    [ensure],
  );

  const getStatus = useCallback((): ChunkStatus => statusRef.current, []);

  // ── Opt-in / turn off (consent.ts) ──────────────────────────────────────
  const repo = config?.repo ?? null;
  const optIn = useCallback(() => {
    if (!repo || !setInTabOptIn(browserLocalStorage(), repo)) return;
    setOptedIn(true);
    // Start the load now, so the status line shows the download instead of the next question waiting on it.
    void ensure().then((hybrid) => hybrid?.warmUp?.());
  }, [ensure, repo]);

  const optOut = useCallback(() => {
    if (!repo) return;
    clearInTabOptIn(browserLocalStorage(), repo);
    setOptedIn(false);
    // Stops a download in flight and frees the GPU; the next opt-in spawns a fresh worker.
    initedRef.current?.dispose?.();
  }, [repo]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // blocked storage: dismissed for this page only
    }
  }, []);

  const offered = status === 'available' && webgpu && !!config && browserLocalStorage() !== null;
  const consent: InTabConsent = {
    // Until the chunk and the config answer, a WebGPU browser keeps the row's space so the opt-in appears without a shift.
    reserve: webgpu && status !== 'unavailable' && (config === undefined || offered),
    offered,
    optedIn: offered && optedIn,
    dismissed,
    downloadSize: config?.downloadSize ?? null,
    serverModel: config?.serverModel ?? null,
    optIn,
    optOut,
    dismiss,
  };

  return { tryLocal, categorizeSample, status, getStatus, modelStatus, consent };
}