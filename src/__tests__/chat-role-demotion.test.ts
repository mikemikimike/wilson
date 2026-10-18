import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import type { LlmResponse } from '../model/types.js';
import type { LlmResult } from '../model/llm.js';
import * as llm from '../model/llm.js';
import * as prompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as orchRegistry from '../orchestration/registry.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { saveConfig, setSetting } from '../utils/config.js';
import {
  getPendingChatApproval, getPendingChatOperation, handleChatMessage, initChatSession, isChatRunActive,
  respondToChatOperation, setChatDeadlineMs,
} from '../dashboard/chat.js';
import {
  createUser, deactivateUser, enableAuth, getUser, LastAdminError, onWriteRevoked, setUserRole, type WriteRevocation,
} from '../dashboard/auth.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { gateToolCall } from '../agent/approval-gate.js';
import { orchestrationGate, runOrchestratedToolCall, DENIED_RESULT } from '../orchestration/tool-calls.js';
import { defineTool } from '../tools/define-tool.js';
import { initEntityClassifyTool } from '../tools/entity/entity-classify.js';
import { createEntity } from '../db/entity-queries.js';

/**
 * #165 — an admin demoted to viewer while their dashboard chat run is in flight must not keep that run's write
 * rights. Every write the run makes re-checks the owner's CURRENT row: a mutating tool call, an approval of its
 * card, a poll of that card, and each "/categorize" batch. That covers a role changed directly in the database,
 * where no hook fires; setUserRole and deactivateUser also act on the run at once through onWriteRevoked.
 * Reads carry on. Drives the real chat module and agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
/** When set, the first agent call (agentHold) or a categorizer / entity-classifier call (categorizeHold) waits for it. */
let agentHold: Promise<void> | null = null;
let categorizeHold: Promise<void> | null = null;
let agentEntered: (() => void) | null = null;
let categorizeEntered: (() => void) | null = null;
let categorizeTargetId = -1;
/** The entity classifier confidently assigns this entity to this (unassigned) row. */
let classifyEntityId = -1;
let classifyTargetId = -1;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType === 'agent') {
    let response: LlmResponse = { content: 'All done.', toolCalls: [] };
    if (options.sequenceNum === 1) {
      agentEntered?.();
      if (agentHold) await agentHold;
      const call = script.shift();
      if (call) response = { content: '', toolCalls: [call] };
    }
    return { response, interactionId: null, traceId: 't', durationMs: 0 };
  }
  categorizeEntered?.();
  if (categorizeHold) await categorizeHold;
  if (options?.callType === 'entity-classification') {
    return {
      response: {
        content: '',
        toolCalls: [],
        structured: { transactions: [{ id: classifyTargetId, entityId: classifyEntityId, confidence: 0.99, reasoning: 'r' }] },
      },
      interactionId: null,
      traceId: 't',
      durationMs: 0,
    };
  }
  // The categorizer: a confident answer for the one uncategorized row.
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

/** Demote the way a hand edit or another process would: straight in the database, no hook. */
const demoteInDb = (db: Database, id: number) =>
  db.prepare("UPDATE dashboard_users SET role = 'viewer' WHERE id = @id").run({ id });

describe('#165: a run whose owner is demoted mid-run loses its writes (in-process)', () => {
  let db: Database;
  let workerId: number;
  let restaurantId: number;
  let releaseAgent: () => void;
  let releaseCategorize: () => void;

  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const category = () =>
    (db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: categorizeTargetId }) as { category: string | null }).category;
  const chatRows = () => db.prepare("SELECT status FROM mcp_operations WHERE source = 'chat'").all() as { status: string }[];
  const worker = () => ({ id: workerId, role: 'admin' as const });
  const poll = () => getPendingChatOperation(db, { profile: 'test', userId: workerId, role: 'admin' });

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    setChatDeadlineMs(2_000);
    db = createTestDb();
    seedTestData(db);
    initChatSession(db);
    await createUser(db, 'boss', 'bosspass1', 'admin');
    workerId = (await createUser(db, 'worker', 'workerpass', 'admin')).id;
    enableAuth(db);
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
    categorizeTargetId = (db.prepare("SELECT id FROM transactions WHERE description = 'Unknown Purchase'").get() as { id: number }).id;
    script = [];
    agentHold = new Promise<void>((r) => (releaseAgent = r));
    categorizeHold = new Promise<void>((r) => (releaseCategorize = r));
  });

  afterEach(async () => {
    releaseAgent();
    releaseCategorize();
    await waitFor(() => !isChatRunActive(), 4000).catch(() => {});
    setChatDeadlineMs(null);
    agentEntered = null;
    categorizeEntered = null;
    agentHold = null;
    categorizeHold = null;
    saveConfig({});
  });

  test('demoted in the database mid model call: the write it then asks for is denied at once, with no card', async () => {
    const entered = new Promise<void>((r) => (agentEntered = r));
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await entered;

    demoteInDb(db, workerId);
    releaseAgent();

    const { answer } = await run;
    expect(answer).toContain('can no longer make changes');
    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows()).toEqual([]);
    expect(exists(restaurantId)).toBe(true);
  });

  test('demoted in the database while a write awaits approval: the next poll denies it and retires the card', async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    expect(poll()).toBeTruthy();

    demoteInDb(db, workerId);

    expect(poll()).toBeNull();
    expect(getPendingChatApproval()).toBeNull();
    expect((await run).answer).toContain('can no longer make changes');
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect(exists(restaurantId)).toBe(true);
  });

  test("approving a card after its owner's demotion is refused and nothing is written", async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    const card = poll()!;

    demoteInDb(db, workerId);

    const result = respondToChatOperation(db, card.id, 'allow-once');
    expect(result.ok).toBe(false);
    await run;
    expect(exists(restaurantId)).toBe(true);
    expect(chatRows()).toEqual([{ status: 'expired' }]);
  });

  test('setUserRole demoting the owner denies a pending approval at once, without waiting for a poll', async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    expect(poll()).toBeTruthy();

    expect(setUserRole(db, workerId, 'viewer')).toBe(true);

    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect((await run).answer).not.toBe('All done.');
    expect(exists(restaurantId)).toBe(true);
  });

  test('reads carry on after the demotion', async () => {
    categorizeHold = null; // the agent's background calls (summaries) take the non-agent branch
    const entered = new Promise<void>((r) => (agentEntered = r));
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } }];
    const run = handleChatMessage('find the restaurant charge', undefined, undefined, { user: worker(), db });
    await entered;

    expect(setUserRole(db, workerId, 'viewer')).toBe(true);
    releaseAgent();

    expect((await run).answer).toBe('All done.');
  });

  test('a /categorize whose owner is demoted in the database while the model answers writes nothing', async () => {
    const entered = new Promise<void>((r) => (categorizeEntered = r));
    const run = handleChatMessage('/categorize', undefined, undefined, { user: worker(), db });
    await entered;

    demoteInDb(db, workerId);
    releaseCategorize();

    expect((await run).answer.toLowerCase()).toContain('cancel');
    expect(category()).toBeNull();
  });

  test('control: a /categorize whose owner keeps their role does write', async () => {
    const entered = new Promise<void>((r) => (categorizeEntered = r));
    const run = handleChatMessage('/categorize', undefined, undefined, { user: worker(), db });
    await entered;
    releaseCategorize();
    await run;
    expect(category()).toBe('Other');
  });

  test('setUserRole stops a /categorize in flight', async () => {
    const entered = new Promise<void>((r) => (categorizeEntered = r));
    const run = handleChatMessage('/categorize', undefined, undefined, { user: worker(), db });
    await entered;

    setUserRole(db, workerId, 'viewer');
    await waitFor(() => !isChatRunActive() || null).catch(() => {});
    releaseCategorize();

    expect((await run).answer.toLowerCase()).toContain('cancel');
    expect(category()).toBeNull();
  });

  test('an approved categorize tool call stops writing once its owner is demoted mid-tool', async () => {
    agentHold = null;
    const entered = new Promise<void>((r) => (categorizeEntered = r));
    script = [{ id: 'tc1', name: 'categorize', args: {} }];
    const run = handleChatMessage('categorize my transactions', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    expect(respondToChatOperation(db, poll()!.id, 'allow-once')).toEqual({ ok: true, status: 'committed' });
    await entered; // the approved tool is now waiting on its categorizer call

    demoteInDb(db, workerId);
    releaseCategorize();

    await run;
    expect(category()).toBeNull();
  });

  describe('an approved entity_classify tool call', () => {
    const entityOf = (id: number) =>
      (db.prepare('SELECT entity_id FROM transactions WHERE id = @id').get({ id }) as { entity_id: number | null }).entity_id;
    const approveEntityClassify = async () => {
      initEntityClassifyTool(db);
      createEntity(db, { name: 'Household' });
      classifyEntityId = createEntity(db, { name: 'Side Business' });
      classifyTargetId = restaurantId;
      agentHold = null;
      const entered = new Promise<void>((r) => (categorizeEntered = r));
      script = [{ id: 'tc1', name: 'entity_classify', args: {} }];
      const run = handleChatMessage('sort my transactions into entities', undefined, undefined, { user: worker(), db });
      await waitFor(() => getPendingChatApproval());
      expect(respondToChatOperation(db, poll()!.id, 'allow-once')).toEqual({ ok: true, status: 'committed' });
      await entered; // the approved tool is now waiting on its classifier call
      return { run }; // wrapped: an async function returning the bare promise would wait for the run itself
    };

    test('stops writing once its owner is demoted mid-tool', async () => {
      const { run } = await approveEntityClassify();
      demoteInDb(db, workerId);
      releaseCategorize();
      await run;
      expect(entityOf(restaurantId)).toBeNull();
    });

    test('control: writes when its owner keeps their role', async () => {
      const { run } = await approveEntityClassify();
      releaseCategorize();
      await run;
      expect(entityOf(restaurantId)).toBe(classifyEntityId);
    });
  });

  test("a demotion drops the session's 'allow-session' approvals, so a re-promoted owner is asked again", async () => {
    agentHold = null;
    categorizeHold = null; // the agent's background calls (summaries) take the non-agent branch
    const otherId = (db.prepare("SELECT id FROM transactions WHERE id != @id ORDER BY id LIMIT 1").get({ id: restaurantId }) as { id: number }).id;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const first = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    expect(respondToChatOperation(db, poll()!.id, 'allow-session')).toEqual({ ok: true, status: 'committed' });
    await first;
    await waitFor(() => !isChatRunActive());
    expect(exists(restaurantId)).toBe(false);

    expect(setUserRole(db, workerId, 'viewer')).toBe(true);
    expect(setUserRole(db, workerId, 'admin')).toBe(true);

    script = [{ id: 'tc2', name: 'delete_transaction', args: { id: otherId } }];
    const second = handleChatMessage('delete another charge', undefined, undefined, { user: worker(), db });
    expect(await waitFor(() => getPendingChatApproval())).toBeTruthy();
    expect(exists(otherId)).toBe(true);
    respondToChatOperation(db, poll()!.id, 'deny');
    await second;
    expect(exists(otherId)).toBe(true);
  });

  test('deactivateUser itself (no HTTP route) cancels the run: the hook lives in auth.ts', async () => {
    agentHold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: worker(), db });
    await waitFor(() => getPendingChatApproval());
    expect(poll()).toBeTruthy();

    expect(deactivateUser(db, workerId)).toBe(true);

    expect((await run).answer).not.toBe('All done.');
    expect(isChatRunActive()).toBe(false);
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect(exists(restaurantId)).toBe(true);
  });
});

describe('#165: demotion in the database reaches the HTTP approval queue', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let workerToken: string;
  let workerId: number;
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
  const chatOps = async (token: string) => {
    const res = await call('/api/mcp/operations', token);
    return ((await res.json()) as { operations: { id: string; source: string }[] }).operations.filter((op) => op.source === 'chat');
  };

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    agentHold = null;
    categorizeHold = null;
    setChatDeadlineMs(10_000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    await createUser(db, 'boss', 'bosspass1', 'admin');
    workerId = (await createUser(db, 'worker', 'workerpass', 'admin')).id;
    enableAuth(db);
    workerToken = ((await (await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'worker', password: 'workerpass' }),
    })).json()) as { token: string }).token;
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    await waitFor(() => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    saveConfig({});
    closeAll();
  });

  test("the demoted owner's card leaves the queue and the run ends long before its deadline", async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', workerToken, 'POST', { query: 'delete the restaurant charge' });
    await waitFor(() => getPendingChatApproval());
    await waitFor(async () => (await chatOps(workerToken))[0]);

    demoteInDb(db, workerId);

    expect(await chatOps(workerToken)).toEqual([]);
    const started = Date.now();
    const { answer } = (await run.then((r) => r.json())) as { answer: string };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer).toContain('can no longer make changes');
    expect(Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId }))).toBe(true);
  });
});

describe('#165: setUserRole', () => {
  test('demotes, fires onWriteRevoked only on a demotion, and refuses to demote the last active admin', async () => {
    const db = createTestDb();
    const a = await createUser(db, 'a', 'apass1234', 'admin');
    const b = await createUser(db, 'b', 'bpass1234', 'admin');
    const seen: [number, WriteRevocation][] = [];
    const off = onWriteRevoked((d, id, why) => { if (d === db) seen.push([id, why]); });
    try {
      expect(setUserRole(db, b.id, 'viewer')).toBe(true);
      expect(getUser(db, b.id)!.role).toBe('viewer');
      expect(setUserRole(db, b.id, 'viewer')).toBe(true); // already a viewer: no write rights lost
      expect(setUserRole(db, b.id, 'admin')).toBe(true); // a promotion revokes nothing
      expect(seen).toEqual([[b.id, 'demoted']]);

      expect(setUserRole(db, 9999, 'viewer')).toBe(false);
      expect(deactivateUser(db, b.id)).toBe(true);
      expect(seen).toEqual([[b.id, 'demoted'], [b.id, 'deactivated']]);

      expect(() => setUserRole(db, a.id, 'viewer')).toThrow(LastAdminError);
      expect(getUser(db, a.id)!.role).toBe('admin');
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });
});

describe('#165: the approval gate re-checks write authority at the call', () => {
  const writer = defineTool({
    name: 'write_thing',
    description: 'writes',
    mutates: true,
    schema: z.object({}),
    func: async () => 'wrote',
  });

  test('a session approval does not wave a write through once mayWrite says no', async () => {
    const session = new Set(['write_thing']);
    let asked = 0;
    const handler = async () => { asked++; return 'allow-once' as const; };
    expect((await gateToolCall('write_thing', writer, {}, handler, session, () => true)).allowed).toBe(true);
    const gate = await gateToolCall('write_thing', writer, {}, handler, session, () => false);
    expect(gate.allowed).toBe(false);
    expect(asked).toBe(0);
  });

  test('rights lost while the approval was pending deny the call, and the session remembers nothing', async () => {
    let allowed = true;
    const session = new Set<string>();
    const handler = async () => { allowed = false; return 'allow-session' as const; };
    const gate = await gateToolCall('write_thing', writer, {}, handler, session, () => allowed);
    expect(gate).toEqual({ asked: true, decision: 'deny', allowed: false });
    expect(session.size).toBe(0);
  });

  test('reads are never asked', async () => {
    const reader = defineTool({ name: 'read_thing', description: 'reads', mutates: false, schema: z.object({}), func: async () => 'read' });
    expect((await gateToolCall('read_thing', reader, {}, undefined, undefined, () => false)).allowed).toBe(true);
  });

  test("a chain step's write is denied once the parent run's mayWrite says no", async () => {
    let ran = 0;
    const tool = defineTool({ name: 'write_thing', description: 'writes', mutates: true, schema: z.object({}), func: async () => { ran++; return 'wrote'; } });
    const gate = orchestrationGate({ requestToolApproval: async () => 'allow-once', mayWrite: () => false });
    const out = await runOrchestratedToolCall({ id: 'c1', name: 'write_thing', args: {} }, new Map([['write_thing', tool]]), gate);
    expect(out).toBe(`[write_thing] ${DENIED_RESULT}`);
    expect(ran).toBe(0);
  });
});
