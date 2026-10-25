import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import type { LlmResponse, ToolDef } from '../model/types.js';
import type { LlmResult } from '../model/llm.js';
import * as llm from '../model/llm.js';
import * as prompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as orchRegistry from '../orchestration/registry.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { saveConfig, setSetting } from '../utils/config.js';
import {
  chatMayUseTools, getPendingChatApproval, getPendingChatOperation, handleChatMessage, initChatSession, isChatRunActive,
  respondToChatOperation, setChatDeadlineMs,
} from '../dashboard/chat.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { setGlobalAgentState } from '../mcp/global-state.js';
import { gateToolCall } from '../agent/approval-gate.js';
import { orchestrationGate, runOrchestratedToolCall, DENIED_RESULT } from '../orchestration/tool-calls.js';
import { defineTool } from '../tools/define-tool.js';
import { transactionSearchTool } from '../tools/query/transaction-search.js';
import { createHybridChat, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import { CHAT_AGENT_ACCESS_OFF_ANSWER } from '../dashboard/ui/src/lib/agentAccessCopy.js';

// @invariant TM-8.9

/**
 * The Agent access kill switch (Settings → Agent access, src/mcp/global-state.ts) gates Wilson's OWN Chat too, not only
 * outside agents. While it is off: a server chat turn returns the access-off reply without calling any model; a tool
 * call attempted after the switch flips mid-run does not run (read or write, also inside a chain); "/categorize" does
 * not run, and one in flight stops before its next batch; the in-tab route refuses answers and the in-tab client does
 * not run; a pending approval card can no longer be approved. The switch is process-global, so it holds across a
 * profile switch, and it applies to every role. Switched on, chat behaves as before. Drives the real chat module and
 * agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
/** When set, the first agent call (agentHold) or a categorizer call (categorizeHold) waits for it. */
let agentHold: Promise<void> | null = null;
let categorizeHold: Promise<void> | null = null;
let agentEntered: (() => void) | null = null;
let categorizeEntered: (() => void) | null = null;
let agentCalls = 0;
let categorizeCalls = 0;
let categorizeTargetId = -1;
/** Runs inside transaction_search, after its read: lets a test flip the switch between a tool and the next model call. */
let onSearch: (() => void) | null = null;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  // The real callLlm refuses before the provider sees the prompt (llm-may-call.test.ts); the script honours it too.
  if (options?.mayCall && !options.mayCall()) throw new llm.ModelCallRefusedError();
  if (options?.callType === 'agent') {
    agentCalls++;
    let response: LlmResponse = { content: 'All done.', toolCalls: [] };
    if (options.sequenceNum === 1) {
      agentEntered?.();
      if (agentHold) await agentHold;
      const call = script.shift();
      if (call) response = { content: '', toolCalls: [call] };
    }
    return { response, interactionId: null, traceId: 't', durationMs: 0 };
  }
  categorizeCalls++;
  categorizeEntered?.();
  if (categorizeHold) await categorizeHold;
  return {
    response: {
      content: '',
      toolCalls: [],
      structured: { transactions: [{ id: categorizeTargetId, category: 'Other', confidence: 0.99 }] },
    },
    interactionId: null,
    traceId: 't',
    durationMs: 0,
  };
});

afterAll(() => {
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Flip the switch the way another process or a hand edit would: the file only, no route, no hook. */
const switchOff = () => setGlobalAgentState({ enabled: false, killSwitchEpoch: Date.now() });
const switchOn = () => setGlobalAgentState({ enabled: true });
const resetSwitch = () => setGlobalAgentState({ enabled: undefined, killSwitchEpoch: undefined });

/** Counts transaction_search runs (the registry's tool map holds this very object). */
function countSearches(): { count: () => number; restore: () => void } {
  const original = transactionSearchTool.func;
  let n = 0;
  (transactionSearchTool as ToolDef).func = async (args, config) => {
    n++;
    const out = await original(args as never, config);
    onSearch?.();
    return out;
  };
  return { count: () => n, restore: () => ((transactionSearchTool as ToolDef).func = original as ToolDef['func']) };
}

function setupProfile(): void {
  ensureTestProfile();
  saveConfig({});
  setSetting('modelId', 'gpt-5.2');
  setSetting('provider', 'openai');
}

describe('Agent access off: Wilson\'s own Chat (in-process)', () => {
  let db: Database;
  let restaurantId: number;
  let searches: ReturnType<typeof countSearches>;
  let releaseAgent: () => void;
  let releaseCategorize: () => void;

  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const category = () =>
    (db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: categorizeTargetId }) as { category: string | null }).category;
  const chatRows = () => db.prepare("SELECT status FROM mcp_operations WHERE source = 'chat'").all() as { status: string }[];
  const poll = () => getPendingChatOperation(db, { profile: 'test', userId: null, role: 'admin' });

  beforeEach(() => {
    setupProfile();
    resetSwitch();
    setChatDeadlineMs(3_000);
    db = createTestDb();
    seedTestData(db);
    initChatSession(db);
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
    categorizeTargetId = (db.prepare("SELECT id FROM transactions WHERE description = 'Unknown Purchase'").get() as { id: number }).id;
    script = [];
    agentCalls = 0;
    categorizeCalls = 0;
    agentHold = new Promise<void>((r) => (releaseAgent = r));
    categorizeHold = new Promise<void>((r) => (releaseCategorize = r));
    searches = countSearches();
  });

  afterEach(async () => {
    releaseAgent();
    releaseCategorize();
    await waitFor(() => !isChatRunActive(), 4000).catch(() => {});
    searches.restore();
    setChatDeadlineMs(null);
    agentEntered = null;
    categorizeEntered = null;
    onSearch = null;
    agentHold = null;
    categorizeHold = null;
    resetSwitch();
    saveConfig({});
  });

  test('a server chat turn returns the access-off reply and never calls the model', async () => {
    switchOff();
    expect(chatMayUseTools()).toBe(false);
    agentHold = null;
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'restaurant' } }];
    const out = await handleChatMessage('how much did I spend on restaurants?');
    expect(out).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, failed: true, agentAccessOff: true });
    expect(agentCalls).toBe(0);
    expect(searches.count()).toBe(0);
    expect(isChatRunActive()).toBe(false);
  });

  test('local help still works while it is off', async () => {
    switchOff();
    const out = await handleChatMessage('/help');
    expect(out.answer).not.toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(out.agentAccessOff).toBeUndefined();
    expect(agentCalls).toBe(0);
  });

  test('switched off mid-run: the read the model then asks for does not run, and nothing it read is answered', async () => {
    const entered = new Promise<void>((r) => (agentEntered = r));
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'restaurant' } }];
    const run = handleChatMessage('how much did I spend on restaurants?');
    await entered;

    switchOff();
    releaseAgent();

    const out = await run;
    expect(out).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, agentAccessOff: true });
    expect(searches.count()).toBe(0);
    expect(agentCalls).toBe(1); // no second model call with tool results
  });

  test('switched off while a tool runs: what it read never reaches another model call', async () => {
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'restaurant' } }];
    onSearch = switchOff;
    releaseAgent();

    const out = await handleChatMessage('how much did I spend on restaurants?');
    expect(out).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, agentAccessOff: true });
    expect(searches.count()).toBe(1); // the read finished before the flip
    expect(agentCalls).toBe(1); // ...but no model call was made with its result
  });

  test('switched off mid-run: the write the model then asks for is denied with no card', async () => {
    const entered = new Promise<void>((r) => (agentEntered = r));
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge');
    await entered;

    switchOff();
    releaseAgent();

    expect((await run).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows()).toEqual([]);
    expect(exists(restaurantId)).toBe(true);
  });

  test('a pending approval: the next poll denies it and retires the card, and approving it is refused', async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge');
    await waitFor(() => getPendingChatApproval());
    const card = poll()!;
    expect(card).toBeTruthy();

    switchOff();

    expect(respondToChatOperation(db, card.id, 'allow-once')).toEqual({ ok: false, error: CHAT_AGENT_ACCESS_OFF_ANSWER, code: 'kill_switch' });
    expect(poll()).toBeNull();
    expect(getPendingChatApproval()).toBeNull();
    expect((await run).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect(exists(restaurantId)).toBe(true);
  });

  test('a pending approval polled after the flip is denied without anyone answering it', async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge');
    await waitFor(() => getPendingChatApproval());
    expect(poll()).toBeTruthy();

    switchOff();

    expect(poll()).toBeNull();
    expect((await run).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect(exists(restaurantId)).toBe(true);
  });

  test('/categorize does not run while it is off', async () => {
    switchOff();
    categorizeHold = null;
    const out = await handleChatMessage('/categorize');
    expect(out).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, agentAccessOff: true });
    expect(categorizeCalls).toBe(0);
    expect(category()).toBeNull();
  });

  test('/categorize in flight stops before its next batch writes when the switch flips', async () => {
    const entered = new Promise<void>((r) => (categorizeEntered = r));
    const run = handleChatMessage('/categorize');
    await entered;

    switchOff();
    releaseCategorize();

    expect((await run).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(category()).toBeNull();
  });

  test('the switch holds across a profile switch (process-global, TM-8.9)', async () => {
    switchOff();
    const other = createTestDb();
    seedTestData(other);
    initChatSession(other);
    agentHold = null;
    expect((await handleChatMessage('what did I spend?', undefined, undefined, { db: other })).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(agentCalls).toBe(0);
  });

  test('applies to every role: a viewer and an admin both get the access-off reply', async () => {
    switchOff();
    agentHold = null;
    for (const user of [{ id: 1, role: 'viewer' as const }, { id: 2, role: 'admin' as const }]) {
      const out = await handleChatMessage('/categorize', undefined, undefined, { user });
      expect(out.answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
      expect((await handleChatMessage('what did I spend?', undefined, undefined, { user })).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    }
    expect(agentCalls).toBe(0);
    expect(categorizeCalls).toBe(0);
  });

  test('switched ON: a read runs and the model answers; an approved write runs; /categorize writes', async () => {
    switchOn();
    agentHold = null;
    categorizeHold = null;
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'restaurant' } }];
    const read = await handleChatMessage('how much did I spend on restaurants?');
    expect(read.answer).toBe('All done.');
    expect(read.agentAccessOff).toBeUndefined();
    expect(searches.count()).toBe(1);

    script = [{ id: 'tc2', name: 'delete_transaction', args: { id: restaurantId } }];
    const write = handleChatMessage('delete the restaurant charge');
    await waitFor(() => getPendingChatApproval());
    const card = poll()!;
    expect(respondToChatOperation(db, card.id, 'allow-once')).toEqual({ ok: true, status: 'committed' });
    await write;
    expect(exists(restaurantId)).toBe(false);

    await handleChatMessage('/categorize');
    expect(category()).toBe('Other');
  });
});

describe('the approval gate asks mayUseTools at the call (reads too, and inside chains)', () => {
  const reader = defineTool({ name: 'read_thing', description: 'reads', mutates: false, schema: z.object({}), func: async () => 'read' });
  const writer = defineTool({ name: 'write_thing', description: 'writes', mutates: true, schema: z.object({}), func: async () => 'wrote' });

  test('a read is refused when mayUseTools says no, and allowed when it says yes', async () => {
    expect(await gateToolCall('read_thing', reader, {}, undefined, undefined, undefined, () => false)).toEqual({ asked: false, decision: null, allowed: false });
    expect((await gateToolCall('read_thing', reader, {}, undefined, undefined, undefined, () => true)).allowed).toBe(true);
  });

  test('a write approved after the switch flipped while its card waited does not run', async () => {
    let on = true;
    const approve = async () => {
      on = false; // flipped while the card was up
      return 'allow-once' as const;
    };
    expect(await gateToolCall('write_thing', writer, {}, approve, new Set(), undefined, () => on)).toEqual({ asked: true, decision: 'deny', allowed: false });
  });

  test('a chain step\'s inner read is refused through the orchestration gate', async () => {
    const ran = spyOn(reader, 'func');
    const out = await runOrchestratedToolCall(
      { id: 'x', name: 'read_thing', args: {} },
      new Map([['read_thing', reader]]),
      orchestrationGate({ mayUseTools: () => false }),
    );
    expect(out).toBe(`[read_thing] ${DENIED_RESULT}`);
    expect(ran).not.toHaveBeenCalled();
    ran.mockRestore();
  });
});

describe('Agent access off: HTTP routes (server chat, in-tab route, pending approval, RBAC)', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let adminToken: string;
  let viewerToken: string;
  let restaurantId: number;

  const call = (path: string, token: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string, password: string) =>
    ((await (await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username, password }),
    })).json()) as { token: string }).token;
  const chatOps = async (token: string) => {
    const res = await call('/api/mcp/operations', token);
    return ((await res.json()) as { operations: { id: string; source: string }[] }).operations.filter((op) => op.source === 'chat');
  };

  beforeEach(async () => {
    setupProfile();
    resetSwitch();
    db = createTestDb();
    seedTestData(db);
    script = [];
    agentCalls = 0;
    agentHold = null;
    categorizeHold = null;
    setChatDeadlineMs(10_000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    await createUser(db, 'boss', 'bosspass1', 'admin');
    await createUser(db, 'reader', 'readerpass', 'viewer');
    enableAuth(db);
    adminToken = await login('boss', 'bosspass1');
    viewerToken = await login('reader', 'readerpass');
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    await waitFor(() => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    resetSwitch();
    saveConfig({});
    closeAll();
  });

  test('POST /api/chat answers the access-off reply for admin and viewer, and GET /api/chat/access says off', async () => {
    switchOff();
    for (const token of [adminToken, viewerToken]) {
      expect(await (await call('/api/chat/access', token)).json()).toEqual({ agentAccess: false });
      const res = await call('/api/chat', token, 'POST', { query: 'what did I spend on restaurants?' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, failed: true, agentAccessOff: true });
    }
    expect(agentCalls).toBe(0);
  });

  test('the in-tab route: /api/chat/local refuses with 403 kill_switch and the config says agentAccess false', async () => {
    switchOff();
    const res = await call('/api/chat/local', adminToken, 'POST', { query: 'q', answer: 'a $12 answer' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_AGENT_ACCESS_OFF_ANSWER, code: 'kill_switch' });
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_history WHERE answer LIKE '%$12 answer%'").get() as { n: number }).n).toBe(0);
    expect(((await (await call('/api/config/local-chat', viewerToken)).json()) as { agentAccess?: boolean }).agentAccess).toBe(false);
  });

  test('switching off through Settings (PUT /api/mcp/settings) stops a run waiting on its card at once; approving it is 403', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', adminToken, 'POST', { query: 'delete the restaurant charge' });
    await waitFor(() => getPendingChatApproval());
    const [card] = await waitFor(async () => {
      const ops = await chatOps(adminToken);
      return ops.length ? ops : null;
    });

    // A viewer cannot flip it.
    expect((await call('/api/mcp/settings', viewerToken, 'PUT', { enabled: false })).status).toBe(403);
    expect((await call('/api/mcp/settings', adminToken, 'PUT', { enabled: false })).status).toBe(200);

    const started = Date.now();
    const answer = (await run.then((r) => r.json())) as { answer: string; agentAccessOff?: boolean };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer).toMatchObject({ answer: CHAT_AGENT_ACCESS_OFF_ANSWER, agentAccessOff: true });
    expect(getPendingChatApproval()).toBeNull();
    expect(await chatOps(adminToken)).toEqual([]);
    const approve = await call(`/api/mcp/operations/${card.id}/approve`, adminToken, 'POST');
    expect(approve.status).not.toBe(200);
    expect(Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId }))).toBe(true);
  });

  test('a card approved after the file flipped (no route, no hook) is refused with 403 kill_switch', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', adminToken, 'POST', { query: 'delete the restaurant charge' });
    await waitFor(() => getPendingChatApproval());
    const [card] = await waitFor(async () => {
      const ops = await chatOps(adminToken);
      return ops.length ? ops : null;
    });
    // Past the approval dwell floor, so only the switch can refuse it.
    db.prepare("UPDATE mcp_operations SET created_at = datetime('now', '-1 minute') WHERE id = @id").run({ id: card.id });

    switchOff();

    const approve = await call(`/api/mcp/operations/${card.id}/approve`, adminToken, 'POST');
    expect(approve.status).toBe(403);
    expect(await approve.json()).toEqual({ error: { code: 'kill_switch', message: CHAT_AGENT_ACCESS_OFF_ANSWER } });
    expect((await run.then((r) => r.json()) as { answer: string }).answer).toBe(CHAT_AGENT_ACCESS_OFF_ANSWER);
    expect(Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId }))).toBe(true);
  });

  test('switched ON: GET /api/chat/access says on, and a chat turn reaches the model', async () => {
    switchOn();
    expect(await (await call('/api/chat/access', viewerToken)).json()).toEqual({ agentAccess: true });
    const res = (await (await call('/api/chat', adminToken, 'POST', { query: 'hello' })).json()) as { answer: string; agentAccessOff?: boolean };
    expect(res.answer).toBe('All done.');
    expect(res.agentAccessOff).toBeUndefined();
    expect(agentCalls).toBeGreaterThan(0);
  });
});

describe('the in-tab client does not run while Agent access is off', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
  }
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

  function harness(state: { agentAccess: boolean; recordStatus?: number }) {
    const config: LocalChatConfigResponse = {
      enabled: true,
      id: 'transformers:onnx-community/Qwen3-0.6B-ONNX',
      repo: 'onnx-community/Qwen3-0.6B-ONNX',
      displayName: 'Qwen3 0.6B',
      downloadSize: '~570MB',
      dtype: 'q4f16',
      bundle: { limit: 200, maxChars: 6000 },
      serverModelLocal: true,
    };
    const urls: string[] = [];
    const log: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      urls.push(input);
      if (input.endsWith('/api/config/local-chat')) return Response.json({ ...config, agentAccess: state.agentAccess });
      if (input.includes('/api/transactions')) return Response.json([]);
      if (input.endsWith('/api/weekly-summary')) {
        return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
      }
      if (input.endsWith('/api/chat/local')) {
        return state.recordStatus === 403
          ? Response.json({ error: CHAT_AGENT_ACCESS_OFF_ANSWER, code: 'kill_switch' }, { status: 403 })
          : Response.json({ sessionId: 's1' });
      }
      return new Response('not found', { status: 404 });
    };
    const backend: ModelBackend = {
      setModel: () => {},
      probe: async () => (log.push('probe'), 'ready'),
      load: async () => (log.push('load'), { loadMs: 1, loadFresh: true, dtype: 'q4f16' }),
      bundleAnswer: async () => (log.push('bundleAnswer'), { kind: 'answer', text: 'bundle answer' }),
      categorize: async () => ({ raw: '', decisionMs: 0 }),
      subagentRun: async () => { throw new Error('not used'); },
      dispose: () => {},
    };
    const chat = createHybridChat({ baseUrl: '', fetchImpl, backend });
    return { chat, urls, log };
  }

  async function warm(chat: { tryLocal: (q: string) => Promise<unknown>; getModelStatus(): { state: string } }) {
    await chat.tryLocal('what did I spend this week?');
    for (let i = 0; i < 500 && chat.getModelStatus().state === 'loading'; i++) await new Promise((r) => setTimeout(r, 1));
  }

  test('off: no probe, no model, no bundle read; the turn goes to the server', async () => {
    const { chat, urls, log } = harness({ agentAccess: false });
    expect(await chat.tryLocal('what did I spend this week?')).toEqual({ ok: false });
    expect(log).toEqual([]);
    expect(urls.some((u) => u.includes('/api/transactions'))).toBe(false);
  });

  test('flipped off between turns: the next turn does not run on-device', async () => {
    const state = { agentAccess: true };
    const { chat, log } = harness(state);
    await warm(chat);
    expect((await chat.tryLocal('what did I spend this week?') as { ok: boolean }).ok).toBe(true);
    state.agentAccess = false;
    const calls = log.filter((l) => l === 'bundleAnswer').length;
    expect(await chat.tryLocal('what did I spend this week?')).toEqual({ ok: false });
    expect(log.filter((l) => l === 'bundleAnswer').length).toBe(calls);
  });

  test('flipped off while a turn ran: the server refuses the answer (403 kill_switch) and it is dropped', async () => {
    const state = { agentAccess: true, recordStatus: 403 };
    const { chat } = harness(state);
    await warm(chat);
    expect(await chat.tryLocal('what did I spend this week?')).toEqual({ ok: false });
  });
});
