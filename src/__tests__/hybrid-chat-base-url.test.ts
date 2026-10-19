import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHybridChat, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import { hybridOptsForOriginFetch } from '../dashboard/ui/src/hybrid/init-opts.js';

/**
 * Regression: the React chat never used the in-tab model. useHybridChat passed
 * the page origin as the hybrid client's baseUrl while its fetchImpl
 * (authedFetch) also prefixes the origin, so every request went to
 * "http://host:porthttp://host:port/api/...", the config fetch failed, and
 * every turn fell back to the server agent with no visible error.
 */

const ORIGIN = 'http://127.0.0.1:4321';
const UI = join(import.meta.dir, '../dashboard/ui/src');

const CONFIG: LocalChatConfigResponse = {
  enabled: true,
  id: 'transformers:onnx-community/gemma-4-E2B-it-ONNX',
  repo: 'onnx-community/gemma-4-E2B-it-ONNX',
  displayName: 'Gemma 4 E2B (WebGPU)',
  downloadSize: '~3.6GB',
  dtype: 'q4',
  bundle: { limit: 200, maxChars: 6000 },
};

/** Behaves like authedFetch: resolves a path against the page origin itself. */
function originFetch() {
  const urls: string[] = [];
  const fn = async (path: string): Promise<Response> => {
    const url = `${ORIGIN}${path}`;
    urls.push(url);
    if (url === `${ORIGIN}/api/config/local-chat`) return Response.json(CONFIG);
    if (url.startsWith(`${ORIGIN}/api/transactions`)) return Response.json([]);
    if (url === `${ORIGIN}/api/weekly-summary`) {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (url === `${ORIGIN}/api/chat/local`) return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
  return { fn, urls };
}

function answeringBackend(): ModelBackend & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    setModel: () => {},
    probe: async () => 'ready',
    load: async () => ({ loadMs: 1, loadFresh: false, dtype: 'q4' }),
    bundleAnswer: async () => {
      log.push('bundleAnswer');
      return { kind: 'answer', text: 'You spent $0 this week.' };
    },
    categorize: async () => ({ raw: '', decisionMs: 0 }),
    subagentRun: async () => ({ outcome: { kind: 'handoff', reason: 'unused', steps: [] }, deviceFault: false }) as never,
    dispose: () => {},
  };
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('hybrid chat init with an origin-prefixing fetch', () => {
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

  test('hybridOptsForOriginFetch keeps baseUrl empty and passes the fetch through', () => {
    const f = async () => new Response();
    expect(hybridOptsForOriginFetch(f)).toEqual({ baseUrl: '', fetchImpl: f });
  });

  test('every request reaches the origin exactly once and the local model answers', async () => {
    const api = originFetch();
    const backend = answeringBackend();
    const chat = createHybridChat({ ...hybridOptsForOriginFetch(api.fn), backend });
    // Warm the model first: a turn never waits for it.
    expect(await chat.loadModel()).not.toBeNull();
    const r = await chat.tryLocal('how much did I spend this week?');
    expect(r).toMatchObject({ ok: true, source: 'local' });
    expect(backend.log).toContain('bundleAnswer');
    expect(api.urls.length).toBeGreaterThan(0);
    for (const url of api.urls) {
      expect(url.startsWith(`${ORIGIN}/api/`)).toBe(true);
      expect(url.indexOf('http', 1)).toBe(-1);
    }
  });

  test('the old wiring (origin as baseUrl too) doubles the origin and never reaches the model', async () => {
    const api = originFetch();
    const backend = answeringBackend();
    const chat = createHybridChat({ baseUrl: ORIGIN, fetchImpl: api.fn, backend });
    const r = await chat.tryLocal('how much did I spend this week?');
    expect(r.ok).toBe(false);
    expect(backend.log).toEqual([]);
    expect(api.urls[0]).toBe(`${ORIGIN}${ORIGIN}/api/config/local-chat`);
  });

  test('the React hook wires authedFetch (which prefixes the origin) through hybridOptsForOriginFetch', () => {
    const api = readFileSync(join(UI, 'api.ts'), 'utf8');
    // async since the login gate: it awaits the response to report a 401.
    expect(api).toMatch(/export (?:async )?function authedFetch[\s\S]*?fetch\(`\$\{getBaseUrl\(\)\}\$\{path\}`/);
    const hook = readFileSync(join(UI, 'hooks/useHybridChat.ts'), 'utf8');
    const inits = hook.match(/hybrid\.init\([^;]*\);/g) ?? [];
    expect(inits.length).toBeGreaterThan(0);
    for (const call of inits) expect(call).toBe('hybrid.init(hybridOptsForOriginFetch(authedFetch));');
  });
});
