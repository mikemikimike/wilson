import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHybridChat, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';

/**
 * Bundle mode end to end on the main thread: the transactions fetch covers the
 * 1st of last month through today (local dates), the bundle carries computed
 * totals, and a local answer whose $ figure is not one the app computed hands
 * the turn to the server the same way NEED_MORE_DATA does. "Today" is injected
 * through the `now` seam, so nothing here depends on the clock.
 */

// 21:30 local on Oct 18: already Oct 19 in UTC for zones west of UTC.
const NOW = new Date(2026, 9, 18, 21, 30);

const CONFIG: LocalChatConfigResponse = {
  enabled: true,
  id: 'transformers:onnx-community/gemma-4-E2B-it-ONNX',
  repo: 'onnx-community/gemma-4-E2B-it-ONNX',
  displayName: 'Gemma 4 E2B (WebGPU)',
  downloadSize: '~3.6GB',
  dtype: 'q4',
  bundle: { limit: 500, maxChars: 6000 },
};

// Newest-first, like GET /api/transactions. Oct dining = $159.50; Sept adds $56.00.
const ROWS = [
  { date: '2026-10-17', description: 'BLUE PLATE DINER', amount: -37.2, category: 'Dining' },
  { date: '2026-10-14', description: 'TACO STAND', amount: -61.3, category: 'Dining' },
  { date: '2026-10-10', description: 'COFFEE BAR', amount: -18.25, category: 'Dining' },
  { date: '2026-10-04', description: 'NOODLE HOUSE', amount: -42.75, category: 'Dining' },
  { date: '2026-09-22', description: 'STEAKHOUSE', amount: -56, category: 'Dining' },
];

function api(rows: unknown[] = ROWS) {
  const urls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url === '/api/config/local-chat') return Response.json(CONFIG);
    if (url.startsWith('/api/transactions')) return Response.json(rows);
    if (url === '/api/weekly-summary') {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (url === '/api/chat/local') return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
  return { fn, urls };
}

function backendAnswering(text: string): ModelBackend & { bundles: string[]; todays: string[] } {
  const bundles: string[] = [];
  const todays: string[] = [];
  return {
    bundles,
    todays,
    setModel: () => {},
    probe: async () => 'ready',
    load: async () => ({ loadMs: 1, loadFresh: false, dtype: 'q4' }),
    bundleAnswer: async (_q, bundleText, today) => {
      bundles.push(bundleText);
      todays.push(today);
      return { kind: 'answer', text };
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

describe('bundle mode: calendar window, computed totals, answer check', () => {
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

  async function ask(answer: string, rows?: unknown[], question = 'how much did I spend on dining this month?') {
    const a = api(rows);
    const backend = backendAnswering(answer);
    const chat = createHybridChat({ baseUrl: '', fetchImpl: a.fn, backend, now: () => NOW });
    expect(await chat.loadModel()).not.toBeNull();
    const result = await chat.tryLocal(question);
    return { result, urls: a.urls, backend };
  }

  test('fetches from the 1st of last month through today, in local dates', async () => {
    const { urls, backend } = await ask('You spent $159.50 on dining this month.');
    expect(urls).toContain('/api/transactions?start=2026-09-01&end=2026-10-18&limit=500');
    expect(backend.todays).toEqual(['2026-10-18']);
  });

  test('the bundle the model sees carries the computed this-month dining total', async () => {
    const { backend } = await ask('You spent $159.50 on dining this month.');
    expect(backend.bundles[0]).toContain('Dining $159.50');
    expect(backend.bundles[0]).toContain('Last month (2026-09-01..2026-09-30): total spending $56.00');
  });

  test('quoting the computed total is answered locally and recorded', async () => {
    const { result, urls } = await ask('You spent $159.50 on dining this month.');
    expect(result).toEqual({ ok: true, answer: 'You spent $159.50 on dining this month.', sessionId: 's1', source: 'local' });
    expect(urls).toContain('/api/chat/local');
  });

  test('regression: the summed-rows answer ($215.50) hands off like NEED_MORE_DATA and is not recorded', async () => {
    const { result, urls } = await ask('You spent $215.50 on dining this month.');
    expect(result).toEqual({ ok: false, reason: 'outside-bundle' });
    expect(urls).not.toContain('/api/chat/local');
  });

  test('threshold question: echoing the question\'s $200 beside the computed total answers locally', async () => {
    const answer = 'No, you spent $159.50 on dining this month, under $200.';
    const { result, urls } = await ask(answer, undefined, 'Did I spend more than $200 on dining this month?');
    expect(result).toEqual({ ok: true, answer, sessionId: 's1', source: 'local' });
    expect(urls).toContain('/api/chat/local');
  });

  test('when the fetch hits the row limit, a total answer hands off (totals could be incomplete)', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      date: '2026-10-10',
      description: `ROW ${i}`,
      amount: -1,
      category: 'Dining',
    }));
    const { result, backend } = await ask('You spent $500.00 on dining this month.', full);
    expect(backend.bundles[0]).toContain('Computed totals: unavailable');
    expect(result).toEqual({ ok: false, reason: 'outside-bundle' });
  });
});
