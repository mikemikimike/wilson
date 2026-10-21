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
import { saveConfig, setSetting } from '../utils/config.js';
import {
  getPendingChatApproval, getPendingChatOperation, handleChatMessage, initChatSession, isChatRunActive,
  respondToChatOperation, setChatDeadlineMs, type ChatUser,
} from '../dashboard/chat.js';
import { createUser, enableAuth, setUserRole } from '../dashboard/auth.js';

/**
 * #172 — the dashboard chat has one runner per profile, so its 'allow-session' approvals used to be shared by
 * every user: user A's "allow for this session" let user B's later run write without a card. Session approvals
 * now belong to the user who gave them (and still last only for the chat session); a user's own are dropped when
 * their write rights are revoked. With auth off there is one anonymous user, who keeps today's behaviour.
 * Drives the real chat module and agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  let response: LlmResponse = { content: 'All done.', toolCalls: [] };
  if (options?.callType === 'agent' && options.sequenceNum === 1) {
    const call = script.shift();
    if (call) response = { content: '', toolCalls: [call] };
  }
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('#172: dashboard chat session approvals are per user', () => {
  let db: Database;
  let rowIds: number[];

  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const poll = (user: ChatUser | null) =>
    getPendingChatOperation(db, { profile: 'test', userId: user?.id ?? null, role: user?.role ?? 'admin' });

  /** One chat message from `user` that deletes `id`; its card is answered with `decision` when one is raised. */
  async function deleteAs(user: ChatUser | null, id: number, decision: 'allow-session' | 'deny' | null) {
    script = [{ id: `tc-${id}`, name: 'delete_transaction', args: { id } }];
    const reply = handleChatMessage('delete a charge', undefined, undefined, { user, db });
    let asked = false;
    if (decision) {
      await waitFor(() => getPendingChatApproval());
      asked = true;
      expect(respondToChatOperation(db, poll(user)!.id, decision).ok).toBe(true);
    }
    await reply;
    await waitFor(() => !isChatRunActive());
    return asked;
  }

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    setChatDeadlineMs(2_000);
    db = createTestDb();
    seedTestData(db);
    initChatSession(db);
    rowIds = (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 4').all() as { id: number }[]).map((r) => r.id);
    script = [];
  });

  afterEach(async () => {
    await waitFor(() => !isChatRunActive(), 4000).catch(() => {});
    setChatDeadlineMs(null);
    saveConfig({});
  });

  describe('auth on, two writers', () => {
    let alice: ChatUser;
    let bob: ChatUser;

    beforeEach(async () => {
      alice = { id: (await createUser(db, 'alice', 'alicepass1', 'admin')).id, role: 'admin' };
      bob = { id: (await createUser(db, 'bob', 'bobpass12', 'admin')).id, role: 'admin' };
      enableAuth(db);
    });

    test("A's allow-session does not let B's run write: B's run raises a card", async () => {
      const [first, second] = rowIds;
      await deleteAs(alice, first, 'allow-session');
      expect(exists(first)).toBe(false);

      script = [{ id: 'tc-b', name: 'delete_transaction', args: { id: second } }];
      const reply = handleChatMessage('delete a charge', undefined, undefined, { user: bob, db });
      expect(await waitFor(() => getPendingChatApproval())).toMatchObject({ tool: 'delete_transaction', args: { id: second } });
      expect(exists(second)).toBe(true);
      respondToChatOperation(db, poll(bob)!.id, 'deny');
      await reply;
      expect(exists(second)).toBe(true);
    });

    test("A's own later run in the session still skips the card", async () => {
      const [first, second] = rowIds;
      await deleteAs(alice, first, 'allow-session');
      // Nobody answers a card here: had one been raised, the run would end at its deadline with the row kept.
      await deleteAs(alice, second, null);
      expect(exists(second)).toBe(false);
      expect(getPendingChatApproval()).toBeNull();
    });

    test("demoting B drops only B's approvals: A still skips the card, re-promoted B is asked again", async () => {
      const [first, second, third, fourth] = rowIds;
      await deleteAs(alice, first, 'allow-session');
      await deleteAs(bob, second, 'allow-session');

      expect(setUserRole(db, bob.id, 'viewer')).toBe(true);
      expect(setUserRole(db, bob.id, 'admin')).toBe(true);

      await deleteAs(alice, third, null);
      expect(exists(third)).toBe(false);

      expect(await deleteAs(bob, fourth, 'deny')).toBe(true);
      expect(exists(fourth)).toBe(true);
    });
  });

  describe('auth off (single anonymous user)', () => {
    test('an allow-session approval still covers the next run, as before', async () => {
      const [first, second] = rowIds;
      await deleteAs(null, first, 'allow-session');
      expect(exists(first)).toBe(false);
      await deleteAs(null, second, null);
      expect(exists(second)).toBe(false);
      expect(getPendingChatApproval()).toBeNull();
    });
  });
});
