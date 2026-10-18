import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createLoadProgressReporter,
  downloadingLabel,
  formatDownloadSize,
  inTabStatusLine,
  IN_TAB_LOADING_LABEL,
  IN_TAB_PREPARING_LABEL,
  loadingLabel,
  type LoadProgressEvent,
} from '../dashboard/ui/src/hybrid/load-progress.js';
import { createModelEngine, type TransformersModule } from '../dashboard/ui/src/hybrid/model-engine.js';
import {
  createHybridChat,
  type InTabModelStatus,
  type LocalChatConfigResponse,
} from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import { isMainToWorker, HYBRID_PROTOCOL_VERSION, type LoadResult } from '../dashboard/ui/src/hybrid/worker-protocol.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';
import { clearDtypeMetadataCache } from '../model/transformers-dtype.js';
import { getDashboardHtml } from '../dashboard/html.js';

/**
 * In-tab model first use (Gemma 4 E2B, ~3.6 GB). The load said "Loading local
 * model… N%" while it was downloading, and the chat turn that triggered it
 * waited for the whole download (~172 s). Now: "Downloading" with the
 * catalog size while bytes are fetched, "Loading" only for cached weights,
 * and a turn never waits: the server answers until the model is ready.
 */

const GEMMA = 'onnx-community/gemma-4-E2B-it-ONNX';

describe('labels', () => {
  test('formatDownloadSize turns the catalog size into display text', () => {
    expect(formatDownloadSize('~3.6GB')).toBe('3.6 GB');
    expect(formatDownloadSize('~570MB')).toBe('570 MB');
    expect(formatDownloadSize('2 gb')).toBe('2 GB');
    expect(formatDownloadSize('unknown')).toBeNull();
    expect(formatDownloadSize('')).toBeNull();
    expect(formatDownloadSize(null)).toBeNull();
  });

  test('the size comes from the catalog entry of the in-tab model, not the UI', () => {
    const cfg = getLocalChatModelConfig();
    expect(cfg.repo).toBe(GEMMA);
    expect(formatDownloadSize(cfg.downloadSize)).toBe('3.6 GB');
  });

  test('downloading and loading wording', () => {
    expect(downloadingLabel('3.6 GB', 42)).toBe('Downloading in-tab model (3.6 GB, first use only)… 42%');
    expect(downloadingLabel('3.6 GB')).toBe('Downloading in-tab model (3.6 GB, first use only)…');
    expect(downloadingLabel(null, 7)).toBe('Downloading in-tab model (first use only)… 7%');
    expect(downloadingLabel('3.6 GB', 99.7)).toBe('Downloading in-tab model (3.6 GB, first use only)… 99%');
    expect(loadingLabel()).toBe('Loading in-tab model…');
    expect(loadingLabel(42.9)).toBe('Loading in-tab model… 42%');
  });

  test('inTabStatusLine: only while loading; "the server answers" only for a local server model', () => {
    const at42 = 'Downloading in-tab model (3.6 GB, first use only)… 42%';
    expect(inTabStatusLine({ state: 'loading', label: at42, serverMeanwhile: true })).toBe(
      "Downloading in-tab model (3.6 GB, first use only)… 42% · the server answers until it's ready",
    );
    expect(inTabStatusLine({ state: 'loading', label: '', serverMeanwhile: true })).toBe(`${IN_TAB_PREPARING_LABEL} · the server answers until it's ready`);
    // Not local (or not said): turns wait, and the line says so.
    expect(inTabStatusLine({ state: 'loading', label: 'Downloading in-tab model (3.6 GB, first use only)…', serverMeanwhile: false })).toBe(
      "Downloading in-tab model (3.6 GB, first use only)… answers start when it's ready",
    );
    expect(inTabStatusLine({ state: 'loading', label: at42, serverMeanwhile: false })).toBe(
      "Downloading in-tab model (3.6 GB, first use only)… 42% · answers start when it's ready",
    );
    expect(inTabStatusLine({ state: 'loading', label: at42 })).not.toContain('server');
    expect(inTabStatusLine({ state: 'idle' })).toBeNull();
    expect(inTabStatusLine({ state: 'ready' })).toBeNull();
    expect(inTabStatusLine({ state: 'failed' })).toBeNull();
  });
});

describe('createLoadProgressReporter', () => {
  function run(cached: boolean | undefined, events: LoadProgressEvent[], downloadSize = '~3.6GB'): string[] {
    const labels: string[] = [];
    const report = createLoadProgressReporter({ cached, downloadSize, emit: (l) => labels.push(l) });
    for (const e of events) report(e);
    return labels;
  }

  test('not cached: "Downloading" with the size and the aggregate percent, "Loading" once the bytes are in', () => {
    const labels = run(false, [
      { status: 'initiate', file: 'config.json' },
      { status: 'progress_total', progress: 42.4 },
      { status: 'progress', file: 'onnx/decoder_model_merged_q4.onnx', progress: 90 },
      { status: 'progress_total', progress: 100 },
    ]);
    expect(labels).toEqual([
      'Downloading in-tab model (3.6 GB, first use only)…',
      'Downloading in-tab model (3.6 GB, first use only)… 42%',
      IN_TAB_LOADING_LABEL,
    ]);
  });

  test('cached: "Loading" throughout, never "Downloading"', () => {
    const labels = run(true, [
      { status: 'initiate', file: 'config.json' },
      { status: 'progress_total', progress: 50 },
      { status: 'progress_total', progress: 100 },
    ]);
    expect(labels).toEqual([IN_TAB_LOADING_LABEL, 'Loading in-tab model… 50%', 'Loading in-tab model… 100%']);
    expect(labels.some((l) => l.startsWith('Downloading'))).toBe(false);
  });

  test('cache state unknown: reported as a download (the only wording true on a first use)', () => {
    expect(run(undefined, [{ status: 'progress_total', progress: 10 }])).toEqual([
      'Downloading in-tab model (3.6 GB, first use only)… 10%',
    ]);
  });

  test('no aggregate events: per-file progress drives the label', () => {
    expect(run(false, [{ status: 'progress', file: 'a.onnx', progress: 30 }], 'unknown')).toEqual([
      'Downloading in-tab model (first use only)… 30%',
    ]);
  });

  test('every progress event is reported, so a slow download keeps the load timeout alive', () => {
    const labels = run(false, [
      { status: 'progress_total', progress: 42.1 },
      { status: 'progress_total', progress: 42.2 },
      { status: 'progress_total', progress: 42.3 },
    ]);
    expect(labels).toHaveLength(3);
  });
});

// ── the engine: cache check before the load picks the wording ────────────

function fakeTransformers(opts: { cached?: boolean | 'throws'; registry?: boolean } = {}) {
  const mod: TransformersModule = {
    env: { remoteHost: 'https://hub.test', backends: { onnx: {} } },
    pipeline: async (_task: string, _repo: string, o: { progress_callback?: (e: LoadProgressEvent) => void }) => {
      o.progress_callback?.({ status: 'initiate', file: 'config.json' });
      o.progress_callback?.({ status: 'progress_total', progress: 42 });
      o.progress_callback?.({ status: 'progress_total', progress: 100 });
      return async () => [{ generated_text: [{ role: 'assistant', content: 'OK' }] }];
    },
  };
  if (opts.registry !== false) {
    mod.ModelRegistry = {
      is_pipeline_cached: async () => {
        if (opts.cached === 'throws') throw new Error('cache unavailable');
        return opts.cached === true;
      },
    };
  }
  return async () => mod;
}

async function engineLabels(tf: () => Promise<TransformersModule>): Promise<string[]> {
  const engine = createModelEngine({ loadTransformers: tf });
  engine.setModel({ repo: GEMMA, displayName: 'Gemma 4 E2B', catalogDtype: 'q4', downloadSize: '~3.6GB' }, 'http://127.0.0.1:3000');
  const labels: string[] = [];
  await engine.load((l) => labels.push(l));
  return labels;
}

describe('model engine load progress', () => {
  beforeEach(() => clearDtypeMetadataCache());

  test('first use (not cached): Downloading with the catalog size, then Loading, then warmup', async () => {
    const labels = await engineLabels(fakeTransformers({ cached: false }));
    expect(labels).toEqual([
      'Downloading in-tab model (3.6 GB, first use only)…',
      'Downloading in-tab model (3.6 GB, first use only)… 42%',
      IN_TAB_LOADING_LABEL,
      'Warming up in-tab model…',
    ]);
  });

  test('cached weights: Loading, never Downloading', async () => {
    const labels = await engineLabels(fakeTransformers({ cached: true }));
    expect(labels.some((l) => l.startsWith('Downloading'))).toBe(false);
    expect(labels).toContain('Loading in-tab model… 42%');
  });

  test('a cache check that throws, or no ModelRegistry, reports a download', async () => {
    for (const tf of [fakeTransformers({ cached: 'throws' }), fakeTransformers({ registry: false })]) {
      const labels = await engineLabels(tf);
      expect(labels).toContain('Downloading in-tab model (3.6 GB, first use only)… 42%');
    }
  });
});

describe('worker protocol: the model config carries the catalog download size', () => {
  test('downloadSize may be a string, null or absent; anything else is rejected', () => {
    const init = (model: Record<string, unknown>) => ({ t: 'init', v: HYBRID_PROTOCOL_VERSION, origin: 'http://127.0.0.1:3000', model });
    const base = { repo: GEMMA, displayName: 'Gemma 4 E2B', catalogDtype: 'q4' };
    expect(isMainToWorker(init({ ...base, downloadSize: '~3.6GB' }))).toBe(true);
    expect(isMainToWorker(init({ ...base, downloadSize: null }))).toBe(true);
    expect(isMainToWorker(init(base))).toBe(true);
    expect(isMainToWorker(init({ ...base, downloadSize: 3.6 }))).toBe(false);
  });
});

// ── the client: a chat turn never waits for the model ────────────────────

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const CFG: LocalChatConfigResponse = {
  enabled: true,
  id: `transformers:${GEMMA}`,
  repo: GEMMA,
  displayName: 'Gemma 4 E2B (WebGPU)',
  downloadSize: '~3.6GB',
  dtype: 'q4',
  bundle: { days: 30, limit: 200, maxChars: 6000 },
  // The server's chat model is local, so the server answers while the in-tab model loads.
  serverModelLocal: true,
};

/** `config()` is read on every request, so a test can move the server's chat model mid-session. */
function dashboardFetch(config: () => Partial<LocalChatConfigResponse> = () => CFG) {
  const urls: string[] = [];
  const fn = async (input: string): Promise<Response> => {
    urls.push(input);
    if (input.endsWith('/api/config/local-chat')) return Response.json({ ...CFG, ...config() });
    if (input.includes('/api/transactions')) return Response.json([]);
    if (input.endsWith('/api/weekly-summary')) {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
  return { fn, urls };
}

/** A backend whose load is held open until the test releases (or fails) it, reporting progress meanwhile. */
function heldBackend() {
  const log: string[] = [];
  let release: (r: LoadResult) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  let progress: ((label: string) => void) | undefined;
  let loaded = false;
  const backend: ModelBackend = {
    setModel: () => {},
    probe: async () => 'ready',
    load: (onProgress) => {
      log.push('load');
      progress = onProgress;
      return new Promise<LoadResult>((resolve, reject) => {
        release = (r) => {
          loaded = true;
          resolve(r);
        };
        fail = reject;
      });
    },
    isLoaded: () => loaded,
    bundleAnswer: async () => {
      log.push('bundleAnswer');
      return { kind: 'answer', text: 'You spent $0 this week.' };
    },
    categorize: async () => ({ raw: '', decisionMs: 0 }),
    subagentRun: async () => {
      throw new Error('unused');
    },
    dispose: () => {},
  };
  return {
    backend,
    log,
    progress: (label: string) => progress?.(label),
    release: () => release({ loadMs: 1, loadFresh: true, dtype: 'q4' }),
    fail: (e: unknown) => fail(e),
  };
}

async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('client: chat turns go to the server until the in-tab model is ready', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
      writable: true,
    });
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedStorage) Object.defineProperty(globalThis, 'sessionStorage', savedStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  test('while downloading, turns resolve {ok:false} at once; once ready, the next turn is answered in the tab', async () => {
    const held = heldBackend();
    const api = dashboardFetch();
    const statuses: InTabModelStatus[] = [];
    const chat = createHybridChat({ baseUrl: '', fetchImpl: api.fn, backend: held.backend, onModelStatus: (s) => statuses.push(s) });

    // The load never settles during these turns: if a turn waited for it, this would hang.
    expect(await chat.tryLocal('how much did I spend?')).toEqual({ ok: false });
    expect(chat.getModelStatus()).toEqual({ state: 'loading', label: IN_TAB_PREPARING_LABEL, serverMeanwhile: true });
    // Nothing is fetched for a bundle the model cannot answer yet.
    expect(api.urls.some((u) => u.includes('/api/transactions'))).toBe(false);

    held.progress('Downloading in-tab model (3.6 GB, first use only)… 42%');
    expect(chat.getModelStatus()).toEqual({ state: 'loading', label: 'Downloading in-tab model (3.6 GB, first use only)… 42%', serverMeanwhile: true });

    expect(await chat.tryLocal('and last week?')).toEqual({ ok: false });
    expect(held.log).toEqual(['load']); // one background load, not one per turn

    held.release();
    await tick();
    expect(chat.getModelStatus()).toEqual({ state: 'ready' });
    expect(statuses.map((s) => s.state)).toEqual(['loading', 'loading', 'ready']);

    const r = await chat.tryLocal('how much did I spend?');
    expect(r).toEqual({ ok: true, answer: 'You spent $0 this week.', sessionId: 's1', source: 'local' });
    expect(held.log).toEqual(['load', 'bundleAnswer']);
  });

  test('progress events that render the same label do not re-publish the status', async () => {
    const held = heldBackend();
    const statuses: InTabModelStatus[] = [];
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch().fn, backend: held.backend, onModelStatus: (s) => statuses.push(s) });
    await chat.tryLocal('q');
    const label42 = 'Downloading in-tab model (3.6 GB, first use only)… 42%';
    // transformers.js fires many byte-level events per whole percent; the reporter forwards each one.
    for (let i = 0; i < 50; i++) held.progress(label42);
    held.progress('Downloading in-tab model (3.6 GB, first use only)… 43%');
    held.progress('Downloading in-tab model (3.6 GB, first use only)… 43%');
    held.progress(IN_TAB_LOADING_LABEL);
    expect(statuses.map((s) => (s.state === 'loading' ? s.label : s.state))).toEqual([
      IN_TAB_PREPARING_LABEL,
      label42,
      'Downloading in-tab model (3.6 GB, first use only)… 43%',
      IN_TAB_LOADING_LABEL,
    ]);
  });

  test('a failed load never breaks chat: turns stay on the server, the failure rides the next turn, and it retries', async () => {
    const held = heldBackend();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch().fn, backend: held.backend });

    expect(await chat.tryLocal('q')).toEqual({ ok: false });
    held.fail({ phase: 'load', message: 'Failed to fetch' });
    await tick();
    expect(chat.getModelStatus()).toMatchObject({ state: 'failed' });

    const r = await chat.tryLocal('q');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toContain('Failed to fetch');
    // A network failure is transient: that turn started a fresh background load.
    expect(held.log).toEqual(['load', 'load']);
    expect(chat.getModelStatus().state).toBe('loading');
  });

  test('server model NOT local: the turn waits for the in-tab model instead of going to the server meanwhile', async () => {
    const held = heldBackend();
    const statuses: InTabModelStatus[] = [];
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: dashboardFetch(() => ({ serverModelLocal: false })).fn,
      backend: held.backend,
      onModelStatus: (s) => statuses.push(s),
    });
    const turnProgress: string[] = [];
    let settledWith: unknown = 'pending';
    const turn = chat.tryLocal('how much did I spend?', (l) => turnProgress.push(l)).then((r) => (settledWith = r));
    await tick();
    expect(settledWith).toBe('pending'); // no {ok:false}: nothing goes to the (cloud) server during the download
    expect(chat.getModelStatus()).toEqual({ state: 'loading', label: IN_TAB_PREPARING_LABEL, serverMeanwhile: false });
    expect(inTabStatusLine(chat.getModelStatus())).toBe("Preparing in-tab model… answers start when it's ready");

    held.progress('Downloading in-tab model (3.6 GB, first use only)… 42%');
    expect(inTabStatusLine(chat.getModelStatus())).toBe("Downloading in-tab model (3.6 GB, first use only)… 42% · answers start when it's ready");
    // The waiting turn shows the same progress in its own bubble.
    expect(turnProgress).toEqual([IN_TAB_PREPARING_LABEL, 'Downloading in-tab model (3.6 GB, first use only)… 42%']);

    held.release();
    await turn;
    expect(settledWith).toEqual({ ok: true, answer: 'You spent $0 this week.', sessionId: 's1', source: 'local' });
    expect(held.log).toEqual(['load', 'bundleAnswer']);
    expect(statuses.every((st) => st.state !== 'loading' || st.serverMeanwhile === false)).toBe(true);
  });

  test('server model NOT local and the load fails: only then does the turn go to the server, with the reason', async () => {
    const held = heldBackend();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(() => ({ serverModelLocal: false })).fn, backend: held.backend });
    const turn = chat.tryLocal('q');
    await tick();
    held.fail({ phase: 'load', message: 'Failed to fetch' });
    const r = await turn;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toContain('Failed to fetch');
  });

  test('an older server (no serverModelLocal) or an unreadable answer counts as not local: the turn waits', async () => {
    for (const config of [() => ({ serverModelLocal: undefined }), () => ({ serverModelLocal: 'yes' as unknown as boolean })]) {
      const held = heldBackend();
      const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(config).fn, backend: held.backend });
      let done = false;
      const turn = chat.tryLocal('q').then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      expect(chat.getModelStatus()).toMatchObject({ state: 'loading', serverMeanwhile: false });
      held.release();
      await turn;
    }
  });

  test('locality is asked per turn: a server model moved to the cloud mid-download stops the hand-offs', async () => {
    const held = heldBackend();
    let serverModelLocal = true;
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch(() => ({ serverModelLocal })).fn, backend: held.backend });
    expect(await chat.tryLocal('q')).toEqual({ ok: false });
    expect(inTabStatusLine(chat.getModelStatus())).toBe("Preparing in-tab model… · the server answers until it's ready");

    serverModelLocal = false; // Settings → Models: chat now on a cloud provider
    let settledWith: unknown = 'pending';
    const turn = chat.tryLocal('how much did I spend?').then((r) => (settledWith = r));
    await tick();
    expect(settledWith).toBe('pending');
    expect(inTabStatusLine(chat.getModelStatus())).toBe("Preparing in-tab model… answers start when it's ready");
    expect(held.log).toEqual(['load']); // it waits on the load already running
    held.release();
    await turn;
    expect(settledWith).toMatchObject({ ok: true, source: 'local' });
  });

  test('categorizeSample (Speed Showdown) still waits for the load, which it times', async () => {
    const held = heldBackend();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: dashboardFetch().fn, backend: held.backend });
    const pending = chat.categorizeSample({ systemPrompt: 's', userPrompt: 'u' });
    await tick();
    held.release();
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(chat.getModelStatus()).toEqual({ state: 'ready' });
  });
});

describe('legacy dashboard (src/dashboard/html.ts) shows the same status line', () => {
  const html = getDashboardHtml(0);
  const start = html.indexOf('var hybridInited = false;');
  const end = html.indexOf('// ── Auth', start);
  if (start < 0 || end < 0) throw new Error('legacy hybridInit not found in dashboard html');

  function runLegacy(statuses: InTabModelStatus[]): Array<{ text: string; hidden: boolean }> {
    const el = { textContent: '', hidden: true };
    const seen: Array<{ text: string; hidden: boolean }> = [];
    const fakeWindow = {
      WilsonHybridChat: {
        init: () => {},
        onModelStatus: (listener: (s: InTabModelStatus) => void) => {
          for (const s of statuses) {
            listener(s);
            seen.push({ text: el.textContent, hidden: el.hidden });
          }
          return () => {};
        },
      },
    };
    const fakeDocument = { getElementById: (id: string) => (id === 'chatModelStatus' ? el : null) };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'BASE', 'authFetch', `${html.slice(start, end)}; hybridInit();`)(
      fakeWindow,
      fakeDocument,
      '',
      async () => new Response(),
    );
    return seen;
  }

  test('has the status element and renders inTabStatusLine for each status', () => {
    expect(html).toContain('id="chatModelStatus"');
    const statuses: InTabModelStatus[] = [
      { state: 'loading', label: 'Downloading in-tab model (3.6 GB, first use only)… 42%', serverMeanwhile: true },
      { state: 'loading', label: 'Downloading in-tab model (3.6 GB, first use only)… 42%', serverMeanwhile: false },
      { state: 'loading', label: 'Downloading in-tab model (3.6 GB, first use only)…', serverMeanwhile: false },
      { state: 'loading', label: '', serverMeanwhile: false },
      { state: 'ready' },
      { state: 'failed', detail: 'x' },
    ];
    expect(runLegacy(statuses)).toEqual(
      statuses.map((s) => {
        const line = inTabStatusLine(s);
        return { text: line ?? '', hidden: !line };
      }),
    );
  });
});
