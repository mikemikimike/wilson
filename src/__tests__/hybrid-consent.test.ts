// @invariant NN-01
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHybridChat, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import {
  clearInTabOptIn,
  inTabOptInCopy,
  inTabOptInKey,
  isInTabOptedIn,
  serverModelLabel,
  setInTabOptIn,
  tryLocalIfOptedIn,
  type ConsentStorage,
} from '../dashboard/ui/src/hybrid/consent.js';

/**
 * NN-01: the in-tab chat model's weights come from huggingface.co. Every Chat
 * message used to call tryLocal, which on a WebGPU browser started the ~3.6 GB
 * download with no consent. Now nothing loads (no probe, no worker, no Hub
 * request, no weights) until the user clicks the Chat opt-in; without it a turn
 * resolves {ok:false, reason:'not-opted-in'} at once and goes to the server.
 */

const UI = join(import.meta.dir, '../dashboard/ui/src');
const REPO = 'onnx-community/gemma-4-E2B-it-ONNX';

function config(over: Partial<LocalChatConfigResponse> = {}): LocalChatConfigResponse {
  return {
    enabled: true,
    id: `transformers:${REPO}`,
    repo: REPO,
    displayName: 'Gemma 4 E2B (WebGPU)',
    downloadSize: '~3.6GB',
    dtype: 'q4',
    bundle: { limit: 200, maxChars: 6000 },
    serverModelLocal: false,
    serverModel: 'claude-sonnet-4-5',
    ...over,
  };
}

function apiFetch(cfg: LocalChatConfigResponse) {
  const urls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url === '/api/config/local-chat') return Response.json(cfg);
    if (url.startsWith('/api/transactions')) return Response.json([]);
    if (url === '/api/weekly-summary') {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (url === '/api/chat/local') return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
  return { fn, urls };
}

/** Records every call; `load` can be made to hang (a 3.6 GB download that never finishes). */
function spyBackend(opts: { hangLoad?: boolean } = {}): ModelBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setModel: () => {
      calls.push('setModel');
    },
    probe: async () => {
      calls.push('probe');
      return 'ready';
    },
    load: async () => {
      calls.push('load');
      if (opts.hangLoad) await new Promise(() => {});
      return { loadMs: 1, loadFresh: true, dtype: 'q4' };
    },
    bundleAnswer: async () => {
      calls.push('bundleAnswer');
      return { kind: 'answer', text: 'You spent $0 this week.' };
    },
    categorize: async () => ({ raw: '', decisionMs: 0 }),
    subagentRun: async () => {
      calls.push('subagentRun');
      return { outcome: { kind: 'handoff', reason: 'unused', steps: [] }, deviceFault: false } as never;
    },
    dispose: () => {
      calls.push('dispose');
    },
  };
}

class MemoryStorage implements ConsentStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const blockedStorage: ConsentStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

/** Resolves 'timeout' if `p` has not settled within `ms` (a turn must not wait for a download it did not consent to). */
function within<T>(p: Promise<T>, ms = 200): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

describe('consent helpers (prelabel pattern: key with a revision, try/catch storage)', () => {
  test('key carries the model repo as its revision', () => {
    expect(inTabOptInKey(REPO)).toBe(`wilson-intab-chat-optin:v1:${REPO}`);
  });

  test('opting in, then out, works', () => {
    const s = new MemoryStorage();
    expect(isInTabOptedIn(s, REPO)).toBe(false);
    expect(setInTabOptIn(s, REPO)).toBe(true);
    expect(isInTabOptedIn(s, REPO)).toBe(true);
    // Consent is per model: another repo (another download) asks again.
    expect(isInTabOptedIn(s, 'onnx-community/other-model-ONNX')).toBe(false);
    clearInTabOptIn(s, REPO);
    expect(isInTabOptedIn(s, REPO)).toBe(false);
    expect(s.data.size).toBe(0);
  });

  test('blocked or missing storage never throws and never counts as consent', () => {
    expect(isInTabOptedIn(blockedStorage, REPO)).toBe(false);
    expect(setInTabOptIn(blockedStorage, REPO)).toBe(false);
    expect(() => clearInTabOptIn(blockedStorage, REPO)).not.toThrow();
    expect(isInTabOptedIn(null, REPO)).toBe(false);
    expect(setInTabOptIn(null, REPO)).toBe(false);
    expect(isInTabOptedIn(new MemoryStorage(), null)).toBe(false);
  });

  test('tryLocalIfOptedIn: without consent the attempt is never called', async () => {
    let attempts = 0;
    const attempt = async () => {
      attempts++;
      return { ok: true as const };
    };
    expect(await tryLocalIfOptedIn(() => false, attempt)).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(await tryLocalIfOptedIn(async () => false, attempt)).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(
      await tryLocalIfOptedIn(() => {
        throw new Error('storage');
      }, attempt),
    ).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(attempts).toBe(0);
    expect(await tryLocalIfOptedIn(() => true, attempt)).toEqual({ ok: true });
    expect(attempts).toBe(1);
  });
});

describe('opt-in copy', () => {
  test('states the size, huggingface.co once, on this device, and who answers until then', () => {
    expect(inTabOptInCopy('~3.6GB', 'claude-sonnet-4-5')).toEqual({
      text: 'Run chat on this device? It downloads the model once (3.6 GB) from huggingface.co (none of your data is sent), then runs in this tab. Until then, questions go to claude-sonnet-4-5.',
      accept: 'Download 3.6 GB',
      dismiss: 'Not now',
    });
    expect(inTabOptInCopy('~3.6GB', 'ollama:gemma4:12b').text).toContain('questions go to gemma4:12b.');
    expect(inTabOptInCopy('unknown', null)).toEqual({
      text: "Run chat on this device? It downloads the model once from huggingface.co (none of your data is sent), then runs in this tab. Until then, questions go to the server's model.",
      accept: 'Download',
      dismiss: 'Not now',
    });
    expect(serverModelLabel('  ')).toBe("the server's model");
  });

  test("never promises a fallback that can't answer (first-timer, 2026-10-25)", () => {
    const off = inTabOptInCopy('~3.6GB', 'ollama:qwen3:8b', false).text;
    expect(off).toEndWith("Until then, Chat can't answer: qwen3:8b isn't ready.");
    expect(off).not.toContain('questions go to');
    // Unknown readiness keeps the plain fallback line.
    expect(inTabOptInCopy('~3.6GB', 'ollama:qwen3:8b', null).text).toContain('questions go to qwen3:8b.');
  });
});

describe('createHybridChat consent gate', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let adapterRequests = 0;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    adapterRequests = 0;
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: {
          requestAdapter: async () => {
            adapterRequests++;
            return { features: { has: () => true } };
          },
        },
      },
      configurable: true,
      writable: true,
    });
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedSession) Object.defineProperty(globalThis, 'sessionStorage', savedSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  for (const serverModelLocal of [true, false]) {
    test(`not opted in (server model ${serverModelLocal ? 'local' : 'cloud'}): no probe, no backend, resolves at once`, async () => {
      const api = apiFetch(config({ serverModelLocal }));
      const backend = spyBackend({ hangLoad: true });
      const storage = new MemoryStorage();
      const asked: string[] = [];
      const chat = createHybridChat({
        baseUrl: '',
        fetchImpl: api.fn,
        backend,
        isOptedIn: (repo) => {
          asked.push(repo);
          return isInTabOptedIn(storage, repo);
        },
      });
      const r = await within(chat.tryLocal('how much did I spend this week?'));
      expect(r).toEqual({ ok: false, reason: 'not-opted-in' });
      expect(asked).toEqual([REPO]);
      expect(backend.calls).toEqual([]);
      expect(adapterRequests).toBe(0);
      // Only the same-origin config read that names the model the consent is for.
      expect(api.urls).toEqual(['/api/config/local-chat']);
      expect(chat.getModelStatus()).toEqual({ state: 'idle' });
      // warmUp (the opt-in click's follow-up) is gated the same way.
      await chat.warmUp();
      expect(backend.calls).toEqual([]);
    });
  }

  test('not opted in: the worker is never constructed', async () => {
    let workers = 0;
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: apiFetch(config()).fn,
      createWorker: () => {
        workers++;
        throw new Error('must not spawn');
      },
      isOptedIn: () => false,
    });
    expect(await chat.tryLocal('what did I spend on groceries?')).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(workers).toBe(0);
  });

  test('not opted in: the in-thread engine never loads transformers.js or asks the Hub', async () => {
    let loads = 0;
    const hub: string[] = [];
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: apiFetch(config({ dtype: null })).fn,
      loadTransformers: async () => {
        loads++;
        throw new Error('must not load');
      },
      hubFetch: async (url: string) => {
        hub.push(url);
        return new Response('{}');
      },
      isOptedIn: () => false,
    });
    expect(await chat.tryLocal('how much did I spend?')).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(loads).toBe(0);
    expect(hub).toEqual([]);
  });

  test('a throwing gate counts as no consent', async () => {
    const backend = spyBackend();
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: apiFetch(config()).fn,
      backend,
      isOptedIn: () => {
        throw new Error('SecurityError');
      },
    });
    expect(await chat.tryLocal('how much did I spend?')).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(backend.calls).toEqual([]);
  });

  test('opt in, then out: the model loads only while opted in', async () => {
    const storage = new MemoryStorage();
    const backend = spyBackend();
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: apiFetch(config({ serverModelLocal: false })).fn,
      backend,
      isOptedIn: (repo) => isInTabOptedIn(storage, repo),
    });

    expect(await chat.tryLocal('how much did I spend this week?')).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(backend.calls).toEqual([]);

    // The click: behaves as before the gate (a cloud server model: the turn waits for the in-tab model).
    setInTabOptIn(storage, REPO);
    const answered = await chat.tryLocal('how much did I spend this week?');
    expect(answered).toMatchObject({ ok: true, source: 'local' });
    expect(backend.calls).toContain('load');
    expect(backend.calls).toContain('bundleAnswer');

    // "Turn off": the next turn skips the model again, without touching the backend.
    clearInTabOptIn(storage, REPO);
    const before = backend.calls.length;
    expect(await chat.tryLocal('how much did I spend this week?')).toEqual({ ok: false, reason: 'not-opted-in' });
    expect(backend.calls.length).toBe(before);
  });

  test('warmUp after the opt-in starts the background load once', async () => {
    const storage = new MemoryStorage();
    const backend = spyBackend({ hangLoad: true });
    const chat = createHybridChat({
      baseUrl: '',
      fetchImpl: apiFetch(config({ serverModelLocal: true })).fn,
      backend,
      isOptedIn: (repo) => isInTabOptedIn(storage, repo),
    });
    setInTabOptIn(storage, REPO);
    await chat.warmUp();
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.calls.filter((c) => c === 'load')).toEqual(['load']);
    expect(chat.getModelStatus()).toMatchObject({ state: 'loading', serverMeanwhile: true });
  });

  test('no gate configured (unit tests of the load path): unchanged behaviour', async () => {
    const backend = spyBackend();
    const chat = createHybridChat({ baseUrl: '', fetchImpl: apiFetch(config()).fn, backend });
    expect(await chat.tryLocal('how much did I spend this week?')).toMatchObject({ ok: true });
  });
});

describe('production wiring', () => {
  test('the hybrid chunk always gates on the stored opt-in, and a caller cannot override it', () => {
    const src = readFileSync(join(UI, 'hybrid/standalone.ts'), 'utf8');
    const calls = src.match(/createHybridChat\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call).toContain('isOptedIn: storedOptIn');
      // After any `...opts` spread, so init(opts) cannot turn the gate off.
      if (call.includes('...opts')) expect(call.indexOf('...opts')).toBeLessThan(call.indexOf('isOptedIn: storedOptIn'));
    }
    expect(src).toMatch(/const storedOptIn = \(repo: string\): boolean => isInTabOptedIn\(browserLocalStorage\(\), repo\);/);
  });

  test('the React hook asks the chunk only after the opt-in check', () => {
    const hook = readFileSync(join(UI, 'hooks/useHybridChat.ts'), 'utf8');
    const tryLocal = hook.slice(hook.indexOf('const tryLocal = useCallback('));
    expect(tryLocal).toMatch(/^const tryLocal = useCallback\([\s\S]*?tryLocalIfOptedIn\(\s*async \(\) => isInTabOptedIn\(browserLocalStorage\(\), \(await loadConfig\(\)\)\?\.repo\),\s*\(\) => runLocal\(/);
    // hybrid.tryLocal is reached only through runLocal.
    expect(hook.match(/hybrid\.tryLocal\(/g)?.length).toBe(1);
    expect(hook.indexOf('hybrid.tryLocal(')).toBeGreaterThan(hook.indexOf('const runLocal = useCallback('));
  });

  test('ChatTab shows the opt-in copy and a turn-off link', () => {
    const tab = readFileSync(join(UI, 'tabs/ChatTab.tsx'), 'utf8');
    expect(tab).toContain('inTabOptInCopy(consent.downloadSize, consent.serverModel, chatReady)');
    expect(tab).toContain('onClick={consent.optIn}');
    expect(tab).toContain('onClick={consent.optOut}');
  });
});

