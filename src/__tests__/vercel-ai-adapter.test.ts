import { describe, test, expect } from 'bun:test';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { VercelAiAdapter } from '../model/providers/vercel-ai.js';

describe('VercelAiAdapter', () => {
  test('sends the system prompt via instructions, not a system message (AI SDK 7 rejects those)', async () => {
    let seen: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        seen = opts;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        } as never;
      },
    });
    const adapter = new VercelAiAdapter(() => model);
    const res = await adapter.call({ model: 'm', systemPrompt: 'SYS-PROMPT', userPrompt: 'hello' } as never);
    expect(res.content).toBe('ok');
    expect(JSON.stringify(seen)).toContain('SYS-PROMPT');
  });

  test('structured-output path also sends the system prompt via instructions', async () => {
    let seen: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        seen = opts;
        return {
          content: [{ type: 'text', text: '{"a":1}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        } as never;
      },
    });
    const adapter = new VercelAiAdapter(() => model);
    const res = await adapter.call({
      model: 'm',
      systemPrompt: 'SYS-PROMPT',
      userPrompt: 'hello',
      outputSchema: z.object({ a: z.number() }),
    } as never);
    expect(JSON.parse(res.content)).toEqual({ a: 1 });
    expect(JSON.stringify(seen)).toContain('SYS-PROMPT');
  });

  // callLlm's withRetry already retries; SDK retries on top made an unreachable model take ~20 s.
  for (const structured of [false, true]) {
    test(`a retryable error is not retried inside the SDK (${structured ? 'structured' : 'text'} path)`, async () => {
      let calls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          throw new APICallError({ message: 'Cannot connect to API', url: 'http://127.0.0.1:9', requestBodyValues: {}, isRetryable: true });
        },
      });
      const adapter = new VercelAiAdapter(() => model);
      const call = adapter.call({
        model: 'm',
        userPrompt: 'hello',
        ...(structured ? { outputSchema: z.object({ a: z.number() }) } : {}),
      } as never);
      await expect(call).rejects.toThrow();
      expect(calls).toBe(1);
    });
  }

  test('structured-output path forwards the abort signal', async () => {
    let seen: { abortSignal?: AbortSignal } | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        seen = opts as { abortSignal?: AbortSignal };
        return {
          content: [{ type: 'text', text: '{"a":1}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        } as never;
      },
    });
    const controller = new AbortController();
    const adapter = new VercelAiAdapter(() => model);
    await adapter.call({ model: 'm', userPrompt: 'hello', outputSchema: z.object({ a: z.number() }), signal: controller.signal } as never);
    expect(seen?.abortSignal).toBeDefined();
  });
});
