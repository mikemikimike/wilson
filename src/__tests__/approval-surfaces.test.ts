import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import type { LlmResponse } from '../model/types.js';
import type { LlmResult } from '../model/llm.js';
import * as llm from '../model/llm.js';
import * as prompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as orchRegistry from '../orchestration/registry.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { initAgentTools } from '../agent/init-tools.js';
import { saveConfig, setSetting } from '../utils/config.js';
import {
  initChatSession,
  handleChatMessage,
  getPendingChatOperation,
  respondToChatOperation,
  setChatDeadlineMs,
} from '../dashboard/chat.js';
import { getOperation } from '../mcp/store.js';
import { createHeadlessRunner, reportHeadlessResult } from '../headless.js';

/**
 * #152 — every surface that runs the agent goes through AgentRunnerController,
 * whose requestToolApproval is the only path into AgentToolExecutor's gate.
 * These tests drive the REAL Agent loop (only the LLM call is scripted) with
 * a real mutating tool against a throwaway DB, once per surface:
 *   - TUI: cli.ts renders runner.pendingApproval and calls respondToApproval
 *   - dashboard chat: the pending approval surfaces as a chat operation that
 *     /api/mcp/operations/:id/{approve,reject} resolves
 *   - headless --run: nobody can answer, so every approval is denied at once
 *     (fail closed) and the output names the denied tool
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let scriptedToolCall: LlmResponse['toolCalls'][number] | null = null;
/** A second tool call for the same run, made on the next LLM turn; `before` runs first (e.g. a mid-run revoke). */
let scriptedFollowUp: { before?: () => void; call: LlmResponse['toolCalls'][number] } | null = null;
let agentCalls = 0;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  agentCalls++;
  if (agentCalls === 2 && scriptedFollowUp) scriptedFollowUp.before?.();
  const response: LlmResponse =
    agentCalls === 1 && scriptedToolCall
      ? { content: '', toolCalls: [scriptedToolCall] }
      : agentCalls === 2 && scriptedFollowUp
        ? { content: '', toolCalls: [scriptedFollowUp.call] }
        : { content: 'All done.', toolCalls: [] };
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  // scopedSpy: never wipe another file's mock of the same export (plain `bun test`).
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function restaurant(db: Database): { id: number; category: string } | null {
  return (db.prepare("SELECT id, category FROM transactions WHERE description = 'Restaurant'").get() ?? null) as
    | { id: number; category: string }
    | null;
}

describe('approval on every agent surface (#152)', () => {
  let db: Database;

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    agentCalls = 0;
  });

  afterEach(() => {
    scriptedToolCall = null;
    scriptedFollowUp = null;
    setChatDeadlineMs(null);
    saveConfig({});
  });

  function runner(): AgentRunnerController {
    initAgentTools(db);
    const history = new InMemoryChatHistory();
    history.setDatabase(db);
    return new AgentRunnerController({ model: 'gpt-5.2', modelProvider: 'openai', maxIterations: 3 }, history);
  }

  describe('TUI / interactive CLI (AgentRunnerController.respondToApproval)', () => {
    test('delete_transaction waits for approval; deny keeps the row', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = runner();
      const done = r.runQuery('delete the restaurant charge');

      const pending = await waitFor(() => r.pendingApproval);
      expect(pending).toEqual({ tool: 'delete_transaction', args: { id }, session: { key: 'delete_transaction' } });
      expect(r.workingState).toEqual({ status: 'approval', toolName: 'delete_transaction' });
      expect(restaurant(db)).toBeTruthy();

      r.respondToApproval('deny');
      await done;
      expect(restaurant(db)).toBeTruthy();
      const types = r.history.at(-1)!.events.map((e) => e.event.type);
      expect(types).toContain('tool_approval');
      expect(types).toContain('tool_denied');
      expect(types).not.toContain('tool_start');
    });

    test('allow-once runs the write', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = runner();
      const done = r.runQuery('delete the restaurant charge');
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-once');
      const result = await done;
      expect(result?.answer).toBe('All done.');
      expect(restaurant(db)).toBeFalsy();
    });

    test('read tools never raise an approval', async () => {
      scriptedToolCall = { id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } };
      const r = runner();
      const result = await r.runQuery('find the restaurant charge');
      expect(result?.answer).toBe('All done.');
      const types = r.history.at(-1)!.events.map((e) => e.event.type);
      expect(types).toContain('tool_start');
      expect(types).not.toContain('tool_approval');
    });
  });

  describe('dashboard chat (server agent + shared confirmation queue)', () => {
    const scope = { profile: 'test', userId: null, role: 'admin' as const };

    test('edit_transaction surfaces as a chat operation; reject keeps the row', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'edit_transaction', args: { id, category: 'Groceries' } };
      initChatSession(db);
      const reply = handleChatMessage('recategorize the restaurant charge as groceries');

      const op = await waitFor(() => getPendingChatOperation(db, scope));
      expect(op.source).toBe('chat');
      expect(op.tool_name).toBe('edit_transaction');
      expect(JSON.parse(op.args_json!)).toEqual({ id, category: 'Groceries' });

      expect(respondToChatOperation(db, op.id, 'deny')).toEqual({ ok: true, status: 'rejected' });
      // Says what happened instead of "No response generated."
      expect((await reply).answer).toBe('Cancelled — you denied edit_transaction.');
      expect(restaurant(db)?.category).toBe('Dining');
      expect(getOperation(db, op.id)?.status).toBe('rejected');
    });

    test('approve runs the write', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'edit_transaction', args: { id, category: 'Groceries' } };
      initChatSession(db);
      const reply = handleChatMessage('recategorize the restaurant charge as groceries');
      const op = await waitFor(() => getPendingChatOperation(db, scope));
      expect(respondToChatOperation(db, op.id, 'allow-once')).toEqual({ ok: true, status: 'committed' });
      expect((await reply).answer).toBe('All done.');
      expect(restaurant(db)?.category).toBe('Groceries');
      expect(getOperation(db, op.id)?.status).toBe('committed');
    });
  });

  describe('headless --run (src/headless.ts) — fails closed', () => {
    function headlessRunner(): AgentRunnerController {
      initAgentTools(db);
      const history = new InMemoryChatHistory();
      history.setDatabase(db);
      return createHeadlessRunner({ model: 'gpt-5.2', modelProvider: 'openai', maxIterations: 3 }, history);
    }

    test('a mutating tool is denied immediately (no hang), never writes, and the output names it', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = headlessRunner();

      // Resolves on its own — nothing ever calls respondToApproval here.
      const result = await r.runQuery('delete the restaurant charge');
      expect(r.pendingApproval).toBeNull();
      expect(restaurant(db)).toBeTruthy();

      const events = r.history.at(-1)!.events.map((e) => e.event);
      expect(events.map((e) => e.type)).not.toContain('tool_start');
      expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({ tool: 'delete_transaction', approved: 'deny' });
      expect(events.map((e) => e.type)).toContain('tool_denied');
      expect(r.lastDeniedTools).toEqual(['delete_transaction']);

      const out: string[] = [];
      const err: string[] = [];
      const code = reportHeadlessResult(result, r, { log: (m) => out.push(m), error: (m) => err.push(m) });
      const text = [...out, ...err].join('\n');
      expect(text).toContain('delete_transaction');
      expect(text).toMatch(/headless/i);
      expect(text).toMatch(/can't approve/i);
      expect(text).toMatch(/interactive/i);
      expect(text).not.toContain('No response generated');
      expect(code).toBe(1);
    });

    test('read tools still run headless and print the answer', async () => {
      scriptedToolCall = { id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } };
      const r = headlessRunner();
      const result = await r.runQuery('find the restaurant charge');
      expect(r.lastDeniedTools).toEqual([]);
      const out: string[] = [];
      const err: string[] = [];
      const code = reportHeadlessResult(result, r, { log: (m) => out.push(m), error: (m) => err.push(m) });
      expect(out).toEqual(['All done.']);
      expect(err).toEqual([]);
      expect(code).toBe(0);
    });
  });

  describe("a deny-policy run (a viewer's chat) ignores the runner's session approvals (#159)", () => {
    test("'allow-session' granted to an ask run does not let a later deny run write", async () => {
      const [first, second] = (db.prepare("SELECT id FROM transactions ORDER BY id LIMIT 2").all() as { id: number }[]).map((r) => r.id);
      const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
      const r = runner();

      // An admin run approves delete_transaction for the session: the runner remembers it.
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id: first } };
      const adminRun = r.runQuery('delete one');
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-session');
      await adminRun;
      expect(exists(first)).toBe(false);

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      // A deny run (a viewer's) must not write, session approval or not, and must not raise a card.
      await r.runQuery('delete another', { approvals: 'deny' });
      expect(exists(second)).toBe(true);
      expect(r.pendingApproval).toBeNull();
      expect(r.lastDeniedTools).toEqual(['delete_transaction']);
      const events = r.history.at(-1)!.events.map((e) => e.event);
      expect(events.map((e) => e.type)).not.toContain('tool_start');
      expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({ tool: 'delete_transaction', approved: 'deny' });
    });

    test('an ask run after the deny run still honours the session approval (the deny run did not clear it)', async () => {
      const [first, second] = (db.prepare("SELECT id FROM transactions ORDER BY id LIMIT 2").all() as { id: number }[]).map((r) => r.id);
      const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
      const r = runner();
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id: first } };
      const adminRun = r.runQuery('delete one');
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-session');
      await adminRun;

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      await r.runQuery('delete another');
      expect(exists(second)).toBe(false);
      expect(r.pendingApproval).toBeNull();
    });
  });

  describe("'allow-session' approvals belong to the user who gave them (#172)", () => {
    const ids = () => (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 3').all() as { id: number }[]).map((r) => r.id);
    const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));

    /** Run a delete as `userId`, answering its approval with `allow-session`. */
    async function approveForSession(r: AgentRunnerController, id: number, userId: number | null | undefined) {
      agentCalls = 0;
      scriptedToolCall = { id: `tc-${id}`, name: 'delete_transaction', args: { id } };
      const run = r.runQuery('delete one', userId === undefined ? {} : { userId });
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-session');
      await run;
      expect(exists(id)).toBe(false);
    }

    test("user A's approval does not wave user B's run through: B is asked", async () => {
      const [first, second] = ids();
      const r = runner();
      await approveForSession(r, first, 1);

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      const bRun = r.runQuery('delete another', { userId: 2 });
      expect(await waitFor(() => r.pendingApproval)).toMatchObject({ tool: 'delete_transaction', args: { id: second } });
      expect(exists(second)).toBe(true);
      r.respondToApproval('deny');
      await bRun;
      expect(exists(second)).toBe(true);
    });

    test("A's own later run in the session still skips the prompt", async () => {
      const [first, second] = ids();
      const r = runner();
      await approveForSession(r, first, 1);

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      await r.runQuery('delete another', { userId: 1 });
      expect(exists(second)).toBe(false);
      expect(r.pendingApproval).toBeNull();
      expect(r.history.at(-1)!.events.map((e) => e.event.type)).not.toContain('tool_approval');
    });

    test("B's own approval is remembered for B, not reused for an anonymous run", async () => {
      const [first, second] = ids();
      const r = runner();
      await approveForSession(r, first, 2);

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      const anon = r.runQuery('delete another');
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('deny');
      await anon;
      expect(exists(second)).toBe(true);
    });

    test('runs that name no user (TUI, auth off) share approvals as before', async () => {
      const [first, second] = ids();
      const r = runner();
      await approveForSession(r, first, undefined);

      agentCalls = 0;
      scriptedToolCall = { id: 'tc2', name: 'delete_transaction', args: { id: second } };
      await r.runQuery('delete another', { userId: null });
      expect(exists(second)).toBe(false);
      expect(r.pendingApproval).toBeNull();
    });

    test("clearSessionApprovals(userId) forgets that user's approvals only", async () => {
      const [first, second, third] = ids();
      const r = runner();
      await approveForSession(r, first, 1);
      await approveForSession(r, second, 2);

      r.clearSessionApprovals(2);

      // A is still remembered...
      agentCalls = 0;
      scriptedToolCall = { id: 'tc3', name: 'delete_transaction', args: { id: third } };
      const aRun = r.runQuery('delete a third', { userId: 1 });
      await aRun;
      expect(exists(third)).toBe(false);
      expect(r.pendingApproval).toBeNull();

      // ...and B is asked again.
      const fourth = (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number }).id;
      agentCalls = 0;
      scriptedToolCall = { id: 'tc4', name: 'delete_transaction', args: { id: fourth } };
      const bRun = r.runQuery('delete a fourth', { userId: 2 });
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('deny');
      await bRun;
      expect(exists(fourth)).toBe(true);
    });

    test('clearSessionApprovals(userId) during a run: the same run asks again at its next write (#165)', async () => {
      const [first, second] = ids();
      const r = runner();
      agentCalls = 0;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id: first } };
      // Between the run's two writes the user loses (and may regain) write rights: onWriteRevoked clears theirs.
      scriptedFollowUp = { before: () => r.clearSessionApprovals(7), call: { id: 'tc2', name: 'delete_transaction', args: { id: second } } };
      const run = r.runQuery('delete two', { userId: 7 });
      expect(await waitFor(() => r.pendingApproval)).toMatchObject({ args: { id: first } });
      r.respondToApproval('allow-session');

      // The approval the run holds was emptied in place, so the second delete is asked for, not waved through.
      expect(await waitFor(() => (r.pendingApproval?.args as { id?: number } | undefined)?.id === second && r.pendingApproval)).toBeTruthy();
      expect(exists(first)).toBe(false);
      expect(exists(second)).toBe(true);
      r.respondToApproval('deny');
      await run;
      expect(exists(second)).toBe(true);
    });

    test('clearSessionApprovals() with no user during a run: the same run asks again too', async () => {
      const [first, second] = ids();
      const r = runner();
      agentCalls = 0;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id: first } };
      scriptedFollowUp = { before: () => r.clearSessionApprovals(), call: { id: 'tc2', name: 'delete_transaction', args: { id: second } } };
      const run = r.runQuery('delete two', { userId: 7 });
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-session');

      expect(await waitFor(() => (r.pendingApproval?.args as { id?: number } | undefined)?.id === second && r.pendingApproval)).toBeTruthy();
      r.respondToApproval('deny');
      await run;
      expect(exists(second)).toBe(true);
    });
  });
});
