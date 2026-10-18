import { describe, expect, test } from 'bun:test';
import {
  isLoopbackHost,
  isLoopbackUrl,
  isModelLocal,
  isOllamaCloudModel,
  localProviderBaseUrl,
  modelLocality,
  recordedCallLocality,
} from '../model/locality.js';
import { isChatProviderLocal } from '../dashboard/local-handoff.js';
import { classifyProvider } from '../demo/privacy.js';
import { buildModelTaskRows } from '../model/task-models.js';

/**
 * The shared "does this call stay on this machine" rule behind the chat
 * provenance badge ("answered on your laptop"), the Settings execution badge
 * and the privacy ledger. Every 'ollama:' model used to count as local.
 * Env is passed explicitly: nothing here reads or changes process.env.
 */

const LOOPBACK = { OLLAMA_BASE_URL: 'http://localhost:11434' };
const LAN = { OLLAMA_BASE_URL: 'http://192.168.1.20:11434' };

describe('isLoopbackHost / isLoopbackUrl', () => {
  test('localhost, 127.0.0.0/8 and ::1 are loopback', () => {
    for (const url of [
      'http://localhost:11434',
      'http://LOCALHOST:11434',
      'http://127.0.0.1:11434',
      'http://127.8.9.10:11434',
      'http://[::1]:11434',
      'http://[0:0:0:0:0:0:0:1]:11434',
      'http://[::ffff:127.0.0.1]:11434',
      'http://127.1:11434',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  test('a LAN IP, a public host, IPv6 non-loopback and look-alikes are not loopback', () => {
    for (const url of [
      'http://192.168.1.20:11434',
      'http://10.0.0.5:11434',
      'http://ollama.example.com',
      'https://ollama.com',
      'http://[fe80::1]:11434',
      'http://[::2]:11434',
      'http://[::ffff:192.168.1.20]:11434',
      'http://0.0.0.0:11434',
      'http://localhost.example.com:11434',
      'http://127.0.0.1.nip.io:11434',
      'http://gpu.localhost:11434',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });

  test('an unparseable URL is not loopback', () => {
    expect(isLoopbackUrl('localhost:11434')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('isOllamaCloudModel', () => {
  test("':cloud' and '-cloud' tags are cloud, with or without the prefix", () => {
    expect(isOllamaCloudModel('ollama:gpt-oss:120b-cloud')).toBe(true);
    expect(isOllamaCloudModel('gpt-oss:20b-cloud')).toBe(true);
    expect(isOllamaCloudModel('ollama:glm-4.6:cloud')).toBe(true);
    expect(isOllamaCloudModel('ollama:Kimi-K2:1T-CLOUD')).toBe(true);
  });

  test('ordinary local tags are not', () => {
    expect(isOllamaCloudModel('ollama:qwen3:8b')).toBe(false);
    expect(isOllamaCloudModel('ollama:gemma4:12b')).toBe(false);
    expect(isOllamaCloudModel('ollama:llama3.1')).toBe(false);
  });
});

describe('modelLocality', () => {
  test('a local Ollama model on the default base URL is local', () => {
    expect(localProviderBaseUrl('ollama', {})).toBe('http://localhost:11434');
    expect(modelLocality('ollama:qwen3:8b', {})).toMatchObject({ local: true, displayName: 'Ollama' });
    expect(isModelLocal('ollama:qwen3:8b', LOOPBACK)).toBe(true);
  });

  test('an Ollama cloud model is cloud, even through the local daemon', () => {
    expect(modelLocality('ollama:gpt-oss:120b-cloud', LOOPBACK)).toMatchObject({ local: false, displayName: 'Ollama Cloud' });
    expect(modelLocality('ollama:glm-4.6:cloud', {})).toMatchObject({ local: false, displayName: 'Ollama Cloud' });
  });

  test('OLLAMA_BASE_URL on a LAN IP is not local, and names the host', () => {
    expect(modelLocality('ollama:qwen3:8b', LAN)).toMatchObject({ local: false, displayName: 'Ollama at 192.168.1.20:11434' });
  });

  test('OLLAMA_BASE_URL on a remote host is not local', () => {
    expect(modelLocality('ollama:qwen3:8b', { OLLAMA_BASE_URL: 'https://gpu.example.com' })).toMatchObject({
      local: false,
      displayName: 'Ollama at gpu.example.com',
    });
  });

  test('OLLAMA_BASE_URL on IPv6 loopback or another 127/8 address stays local', () => {
    expect(isModelLocal('ollama:qwen3:8b', { OLLAMA_BASE_URL: 'http://[::1]:11434' })).toBe(true);
    expect(isModelLocal('ollama:qwen3:8b', { OLLAMA_BASE_URL: 'http://127.0.0.2:11434' })).toBe(true);
  });

  test('an unparseable OLLAMA_BASE_URL is not local', () => {
    expect(modelLocality('ollama:qwen3:8b', { OLLAMA_BASE_URL: 'ollama-box:11434' })).toMatchObject({
      local: false,
      displayName: 'Ollama',
    });
  });

  test('an empty OLLAMA_BASE_URL falls back to localhost, as the provider factory does', () => {
    expect(isModelLocal('ollama:qwen3:8b', { OLLAMA_BASE_URL: '' })).toBe(true);
  });

  test('Transformers.js runs in-process: local, whatever OLLAMA_BASE_URL says', () => {
    expect(isModelLocal('transformers:onnx-community/gemma-4-E2B-it-ONNX', LAN)).toBe(true);
  });

  test('cloud providers stay cloud', () => {
    expect(modelLocality('claude-haiku-4-5', LOOPBACK)).toMatchObject({ local: false, displayName: 'Anthropic' });
    expect(modelLocality('gpt-5.2', LOOPBACK)).toMatchObject({ local: false, displayName: 'OpenAI' });
    expect(isModelLocal('litellm:some-model', LOOPBACK)).toBe(false);
  });

  test('recordedCallLocality takes a trace row (provider id + bare model); unknown providers are undefined', () => {
    expect(recordedCallLocality('ollama', 'qwen3:8b', LOOPBACK)?.local).toBe(true);
    expect(recordedCallLocality('ollama', 'gpt-oss:120b-cloud', LOOPBACK)?.local).toBe(false);
    expect(recordedCallLocality('ollama', 'qwen3:8b', LAN)?.local).toBe(false);
    expect(recordedCallLocality('acme-cloud', 'x', LOOPBACK)).toBeUndefined();
  });
});

// The consumers read process.env, so these set and restore OLLAMA_BASE_URL.
function withOllamaBaseUrl<T>(url: string | undefined, run: () => T): T {
  const saved = process.env.OLLAMA_BASE_URL;
  if (url === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = url;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
}

describe('consumers use the shared rule', () => {
  test('isChatProviderLocal: an Ollama cloud model or a LAN base URL is not local', () => {
    withOllamaBaseUrl(undefined, () => {
      expect(isChatProviderLocal({ provider: 'ollama', model: 'ollama:qwen3:8b' })).toBe(true);
      expect(isChatProviderLocal({ provider: 'ollama', model: 'ollama:gpt-oss:120b-cloud' })).toBe(false);
    });
    withOllamaBaseUrl('http://192.168.1.20:11434', () => {
      expect(isChatProviderLocal({ provider: 'ollama', model: 'ollama:qwen3:8b' })).toBe(false);
    });
    withOllamaBaseUrl('http://[::1]:11434', () => {
      expect(isChatProviderLocal({ provider: 'ollama', model: 'ollama:qwen3:8b' })).toBe(true);
    });
  });

  test('privacy ledger: a cloud or remote Ollama row is CLOUD, not localhost', () => {
    withOllamaBaseUrl(undefined, () => {
      expect(classifyProvider('ollama', 'qwen3:8b')).toBe('local');
      expect(classifyProvider('ollama', 'gpt-oss:120b-cloud')).toBe('cloud');
    });
    withOllamaBaseUrl('http://10.0.0.5:11434', () => {
      expect(classifyProvider('ollama', 'qwen3:8b')).toBe('cloud');
    });
  });

  test('Settings task rows: a cloud Ollama model runs on a server', () => {
    withOllamaBaseUrl(undefined, () => {
      const rows = buildModelTaskRows('ollama:qwen3:8b', false, { categorization: 'ollama:gpt-oss:120b-cloud' });
      expect(rows.find((r) => r.task === 'chat')?.execution).toBe('local');
      expect(rows.find((r) => r.task === 'categorization')?.execution).toBe('server');
    });
  });
});
