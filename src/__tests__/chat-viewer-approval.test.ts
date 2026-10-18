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
import { handleChatMessage, getPendingChatApproval, isChatRunActive, setChatDeadlineMs } from '../dashboard/chat.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';

/**
 * #156 — with dashboard auth on, a `viewer` must not be able to make the chat
 * agent write. The direct REST write routes refuse viewers with 403; the chat
 * approval card must too:
 *   - POST /api/mcp/operations/:id/approve on a chat card requires canWrite
 *     (403 for a viewer, nothing written);
 *   - a chat run started by a viewer denies every mutating tool call at once
 *     (no card is raised), and says why;
 *   - a chat card belongs to the user whose run raised it, so another user
 *     cannot see, approve or reject it;
 *   - "/categorize" (which writes without a card) is refused for viewers.
 * Drives the real server and agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  let response: LlmResponse = { content: 'All done.', toolCalls: [] };
  if (options.sequenceNum === 1) {
    const call = script.shift();
    if (call) response = { content: '', toolCalls: [call] };
  }
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  // scopedSpy: never wipe another file's mock of the same export (plain `bun test`).
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitForAsync<T>(probe: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Op = { id: string; source: string; tool_name: string; status: string; user_id: number | null };

describe('#156: a viewer cannot approve chat operations', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let adminToken: string;
  let viewerToken: string;
  let restaurantId: number;

  const call = (path: string, token: string | null, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // What the dashboard page sends: approving needs this browser proof (origin-gate.ts requireBrowserProof).
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const chatOps = async (token: string): Promise<Op[]> => {
    const res = await call('/api/mcp/operations', token);
    const body = (await res.json()) as { operations: Op[] };
    return body.operations.filter((op) => op.source === 'chat');
  };
  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const login = async (username: string, password: string) =>
    ((await (await call('/api/auth/login', null, 'POST', { username, password })).json()) as { token: string }).token;

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    setChatDeadlineMs(3000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    await createUser(db, 'admin', 'adminpass', 'admin');
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);
    adminToken = await login('admin', 'adminpass');
    viewerToken = await login('viewer', 'viewerpass');
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    // Let any run the test left behind wind down before the next one.
    await waitForAsync(async () => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    saveConfig({});
    closeAll();
  });

  test('issue repro: an unowned chat card is never handed to the viewer who polls first; the write is denied', async () => {
    // A run with no known owner (an in-process caller) while auth is on: its card would belong to nobody, and
    // stamping it with whoever polls first would hand it to the viewer. Instead no card is raised and the agent is
    // told "no" at once (the WebMCP rule; with auth off the single implicit user owns it).
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge');
    for (let i = 0; i < 20 && isChatRunActive(); i++) {
      expect(await chatOps(viewerToken)).toEqual([]);
      await new Promise((r) => setTimeout(r, 10));
    }
    const { answer } = await run;
    expect(answer).toContain('delete_transaction');
    expect(exists(restaurantId)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_operations WHERE source = 'chat'").get() as { n: number }).n).toBe(0);
  });

  test('a viewer\'s chat denies mutating tools at once — no card, a clear answer, nothing written', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const res = await call('/api/chat', viewerToken, 'POST', { query: 'delete the restaurant charge' });
    expect(res.status).toBe(200);
    const { answer } = (await res.json()) as { answer: string };
    expect(answer).toMatch(/viewer/i);
    expect(answer).toContain('delete_transaction');
    expect(answer).toMatch(/nothing was changed/i);
    expect(exists(restaurantId)).toBe(true);
    expect(await chatOps(viewerToken)).toEqual([]);
    expect(await chatOps(adminToken)).toEqual([]);
  });

  test('an admin\'s chat card belongs to the admin: a viewer polling first cannot see, approve or reject it', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', adminToken, 'POST', { query: 'delete the restaurant charge' });
    // The viewer polls (first) while the admin's request waits.
    await waitForAsync(async () => getPendingChatApproval());
    expect(await chatOps(viewerToken)).toEqual([]);

    const card = await waitForAsync(async () => (await chatOps(adminToken))[0]);
    expect((await call(`/api/mcp/operations/${card.id}/approve`, viewerToken, 'POST')).status).toBe(404);
    expect((await call(`/api/mcp/operations/${card.id}/reject`, viewerToken, 'POST')).status).toBe(404);
    expect(exists(restaurantId)).toBe(true);

    expect((await call(`/api/mcp/operations/${card.id}/approve`, adminToken, 'POST')).status).toBe(200);
    expect(((await (await run).json()) as { answer: string }).answer).toBe('All done.');
    expect(exists(restaurantId)).toBe(false);
  });

  test('"/categorize" is refused for a viewer and categorizes nothing', async () => {
    const uncategorized = () => (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL OR category = ''").get() as { n: number }).n;
    const before = uncategorized();
    const res = await call('/api/chat', viewerToken, 'POST', { query: '/categorize' });
    const { answer } = (await res.json()) as { answer: string };
    expect(answer).toMatch(/viewer/i);
    expect(uncategorized()).toBe(before);
  });

  test('read-only chat still works for a viewer', async () => {
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } }];
    const res = await call('/api/chat', viewerToken, 'POST', { query: 'find the restaurant charge' });
    expect(((await res.json()) as { answer: string }).answer).toBe('All done.');
  });
});

describe('#167: /api/chat says where the server agent model runs, for the provenance badge', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;

  const chat = async (query: string) => {
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ query }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { answer: string; serverModelLocal?: unknown; serverProvider?: unknown };
  };

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    setChatDeadlineMs(3000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await waitForAsync(async () => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    saveConfig({});
    closeAll();
  });

  test('a cloud model is reported as not local and named', async () => {
    const body = await chat('hello');
    expect(body.answer).toBe('All done.');
    expect(body.serverModelLocal).toBe(false);
    expect(body.serverProvider).toBe('OpenAI');
  });

  test('switching to a local model flips the next reply to local, with no provider named', async () => {
    await chat('hello');
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'ollama');
    const body = await chat('hello again');
    expect(body.serverModelLocal).toBe(true);
    expect(body.serverProvider).toBeNull();
  });

  test('a provider/model mismatch is never reported as local, and never names the local runtime', async () => {
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'openai');
    const body = await chat('hello');
    expect(body.serverModelLocal).toBe(false);
    expect(body.serverProvider).toBeNull();
  });

  // The agent's categorize / entity-classify tools send ledger rows to their
  // own task model, so a cloud pin there makes the reply cloud too.
  test('a local chat model with categorization pinned to a cloud model is not local, and names that provider', async () => {
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'ollama');
    setSetting('modelOverride.categorization', 'claude-haiku-4-5');
    const body = await chat('hello');
    expect(body.serverModelLocal).toBe(false);
    expect(body.serverProvider).toBe('Anthropic');
  });

  test('a cloud entity-classification pin also counts', async () => {
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'ollama');
    setSetting('modelOverride.entity-classification', 'gpt-5.2');
    const body = await chat('hello');
    expect(body.serverModelLocal).toBe(false);
    expect(body.serverProvider).toBe('OpenAI');
  });

  test('a cloud chat model is named over a cloud task pin', async () => {
    setSetting('modelOverride.categorization', 'claude-haiku-4-5');
    const body = await chat('hello');
    expect(body.serverModelLocal).toBe(false);
    expect(body.serverProvider).toBe('OpenAI');
  });

  test('a local task pin keeps a local chat model local', async () => {
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'ollama');
    setSetting('modelOverride.categorization', 'ollama:gemma4:12b');
    setSetting('modelOverride.entity-classification', 'transformers:onnx-community/gemma-4-E2B-it-ONNX');
    const body = await chat('hello');
    expect(body.serverModelLocal).toBe(true);
    expect(body.serverProvider).toBeNull();
  });

  // An 'ollama:' model is not automatically local: a cloud tag goes to
  // ollama.com, and OLLAMA_BASE_URL can point at another machine. callLlm is
  // scripted, so nothing here reaches Ollama.
  describe('Ollama cloud models and remote base URLs', () => {
    const savedBaseUrl = process.env.OLLAMA_BASE_URL;
    afterEach(() => {
      if (savedBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = savedBaseUrl;
    });

    test('an Ollama cloud model is not local, and is named as Ollama Cloud', async () => {
      delete process.env.OLLAMA_BASE_URL;
      setSetting('modelId', 'ollama:gpt-oss:120b-cloud');
      setSetting('provider', 'ollama');
      const body = await chat('hello');
      expect(body.serverModelLocal).toBe(false);
      expect(body.serverProvider).toBe('Ollama Cloud');
    });

    test('OLLAMA_BASE_URL on a LAN IP is not local, and names the host', async () => {
      process.env.OLLAMA_BASE_URL = 'http://192.168.1.20:11434';
      setSetting('modelId', 'ollama:qwen3:8b');
      setSetting('provider', 'ollama');
      const body = await chat('hello');
      expect(body.serverModelLocal).toBe(false);
      expect(body.serverProvider).toBe('Ollama at 192.168.1.20:11434');
    });

    test('OLLAMA_BASE_URL on IPv6 loopback stays local', async () => {
      process.env.OLLAMA_BASE_URL = 'http://[::1]:11434';
      setSetting('modelId', 'ollama:qwen3:8b');
      setSetting('provider', 'ollama');
      const body = await chat('hello');
      expect(body.serverModelLocal).toBe(true);
      expect(body.serverProvider).toBeNull();
    });

    test('a local chat model with categorization pinned to an Ollama cloud model is not local', async () => {
      delete process.env.OLLAMA_BASE_URL;
      setSetting('modelId', 'ollama:qwen3:8b');
      setSetting('provider', 'ollama');
      setSetting('modelOverride.categorization', 'ollama:glm-4.6:cloud');
      const body = await chat('hello');
      expect(body.serverModelLocal).toBe(false);
      expect(body.serverProvider).toBe('Ollama Cloud');
    });
  });
});
