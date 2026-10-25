import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { callLlm, ModelCallRefusedError } from '../model/llm.js';
import { getAdapter } from '../model/providers/index.js';

/**
 * callLlm `mayCall` (the dashboard chat's Agent access switch): asked before every attempt, so once it says no the
 * prompt never reaches the provider, including a retry after a failed first attempt.
 */
describe('callLlm mayCall', () => {
  const adapter = getAdapter('ollama');
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  test('refused: throws ModelCallRefusedError and the adapter is never called', async () => {
    spy = spyOn(adapter, 'call').mockImplementation(async () => ({ content: 'leaked', toolCalls: [] }));
    await expect(callLlm('secret rows', { model: 'ollama:granite4.1:3b', mayCall: () => false })).rejects.toBeInstanceOf(ModelCallRefusedError);
    expect(spy).not.toHaveBeenCalled();
  });

  test('turned off after a failed first attempt: the retry is not sent', async () => {
    let allowed = true;
    spy = spyOn(adapter, 'call').mockImplementation(async () => {
      allowed = false;
      throw new Error('fetch failed: ECONNRESET');
    });
    await expect(callLlm('secret rows', { model: 'ollama:granite4.1:3b', mayCall: () => allowed })).rejects.toBeInstanceOf(ModelCallRefusedError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('allowed: the call goes through', async () => {
    spy = spyOn(adapter, 'call').mockImplementation(async () => ({ content: 'ok', toolCalls: [] }));
    const { response } = await callLlm('hi', { model: 'ollama:granite4.1:3b', mayCall: () => true });
    expect(response.content).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
