import { describe, expect, test } from 'bun:test';
import {
  deriveChatProvenance,
  PROVENANCE_BADGES,
  PROVENANCE_LABELS,
  provenanceBadge,
} from '../dashboard/ui/src/hybrid/core.js';
import type { ChatProvenance, ServerModelInfo } from '../dashboard/ui/src/hybrid/core.js';
import { getDashboardHtml } from '../dashboard/html.js';
import { PROVIDERS } from '../providers.js';

/**
 * Per-response chat provenance: which path actually produced a live chat
 * response. The derivation takes two booleans taken at send time — whether
 * the local WebGPU path answered, and whether the hybrid layer (the prebuilt
 * chunk) was present at all — and never looks at message text. Semantics:
 *
 * - 'local-with-context': the browser's WebGPU model answered from the
 *   pre-fetched bundle (tryLocal returned {ok:true}).
 * - 'server-fallback': the server agent answered after the local layer was
 *   in play — hand-off (tool-call / outside-bundle / no-answer), cached
 *   WebGPU unavailable/failed verdict, config or bundle fetch failure, local
 *   error. HybridResult.reason deliberately does NOT influence the badge.
 * - 'unavailable' (neutral): the hybrid layer itself was absent (chunk 404 /
 *   window global undefined), so local inference was skipped entirely.
 */

describe('deriveChatProvenance', () => {
  describe('local answered → local-with-context, regardless of layer presence', () => {
    test('hybrid layer present', () => {
      expect(deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true })).toBe(
        'local-with-context',
      );
    });

    test('hybrid layer absent (cannot happen in practice, but the local win dominates)', () => {
      expect(deriveChatProvenance({ localAnswered: true, hybridLayerPresent: false })).toBe(
        'local-with-context',
      );
    });
  });

  describe('local layer in play, server answered → server-fallback', () => {
    test('covers every {ok:false} reason: hand-offs, WebGPU unavailability, errors', () => {
      // The reason never changes the badge — the derivation never sees it.
      expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true })).toBe(
        'server-fallback',
      );
    });
  });

  describe('hybrid layer absent → unavailable (neutral)', () => {
    test('local inference skipped entirely (chunk 404 / window global undefined)', () => {
      expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false })).toBe(
        'unavailable',
      );
    });
  });

  test('derivation never reads message content — inputs are booleans only', () => {
    // Exhaustive matrix: 2 × 2 inputs → exactly three outputs.
    expect(
      new Set([
        deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true }),
        deriveChatProvenance({ localAnswered: true, hybridLayerPresent: false }),
        deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true }),
        deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false }),
      ]),
    ).toEqual(new Set(['local-with-context', 'server-fallback', 'unavailable']));
  });
});

describe('PROVENANCE_BADGES', () => {
  const expectedStates: ChatProvenance[] = [
    'local-with-context',
    'local-tools',
    'server-continued',
    'server-fallback',
    'unavailable',
  ];

  test('has exactly the five ChatProvenance keys, no more', () => {
    expect(Object.keys(PROVENANCE_BADGES).sort()).toEqual([...expectedStates].sort());
  });

  test('every label is non-empty', () => {
    for (const state of expectedStates) {
      expect(PROVENANCE_BADGES[state].length).toBeGreaterThan(0);
    }
  });

  test('all five labels are distinct (guards a copy-paste typo shipping a wrong badge)', () => {
    expect(new Set(Object.values(PROVENANCE_BADGES)).size).toBe(expectedStates.length);
  });

  test('browser-local badges use the spec wording', () => {
    expect(PROVENANCE_BADGES['local-with-context']).toBe('answered locally · on-device');
    expect(PROVENANCE_BADGES['local-tools']).toBe('answered locally · on-device lookups');
    expect(PROVENANCE_BADGES['unavailable']).toBe('server agent');
  });

  test('with no server model information the server states use cloud wording (#167)', () => {
    expect(PROVENANCE_BADGES['server-fallback']).toBe('answered by the server · cloud model');
    expect(PROVENANCE_BADGES['server-continued']).toBe('continued by the server from browser lookups · cloud model');
  });

  test('the old "server fallback" wording is gone', () => {
    expect(Object.values(PROVENANCE_BADGES)).not.toContain('server fallback');
  });
});

// Every server-model answer the badge can be asked about: local, each cloud
// provider by name, and the ways a reply can be unknown or malformed.
const LOCAL_INFO: ServerModelInfo = { serverModelLocal: true, serverProvider: null };
const CLOUD_PROVIDER_NAMES = PROVIDERS.filter((p) => !p.isLocal).map((p) => p.displayName);
const NOT_LOCAL_INFOS: Array<ServerModelInfo | undefined> = [
  undefined,
  {},
  { serverModelLocal: false },
  { serverModelLocal: false, serverProvider: null },
  { serverModelLocal: false, serverProvider: '   ' },
  { serverModelLocal: 'true' as unknown as boolean },
  { serverModelLocal: 1 as unknown as boolean },
  ...CLOUD_PROVIDER_NAMES.map((name) => ({ serverModelLocal: false, serverProvider: name })),
  // A LAN Ollama (OLLAMA_BASE_URL): another machine, still not local.
  { serverModelLocal: false, serverProvider: 'Ollama', serverHost: '192.168.1.20:11434' },
  { serverModelLocal: false, serverProvider: 'Ollama', serverHost: '   ' },
  { serverModelLocal: false, serverProvider: null, serverHost: '10.0.0.5:11434' },
  { serverModelLocal: false, serverHost: 7 as unknown as string },
];
const LOCAL_WORDS = /local|on-device|laptop/i;

describe('provenanceBadge: server wording follows where the server model runs (#167)', () => {
  test('server-fallback with a local server model says "answered on your laptop"', () => {
    expect(provenanceBadge('server-fallback', LOCAL_INFO)).toBe('answered on your laptop');
    expect(provenanceBadge('server-fallback', { serverModelLocal: true, serverProvider: 'OpenAI' })).toBe(
      'answered on your laptop',
    );
  });

  test('server-fallback with a cloud model names the provider', () => {
    expect(provenanceBadge('server-fallback', { serverModelLocal: false, serverProvider: 'Anthropic' })).toBe(
      'answered by Anthropic · cloud model',
    );
  });

  test('unknown, absent or malformed server info gets cloud wording, never local', () => {
    expect(provenanceBadge('server-fallback')).toBe('answered by the server · cloud model');
    expect(provenanceBadge('server-fallback', { serverModelLocal: 'true' as unknown as boolean })).toBe(
      'answered by the server · cloud model',
    );
  });

  test('a LAN runtime (another machine) gets its own wording, not "cloud model" and never local', () => {
    const lan: ServerModelInfo = { serverModelLocal: false, serverProvider: 'Ollama', serverHost: '192.168.1.20:11434' };
    expect(provenanceBadge('server-fallback', lan)).toBe('answered by Ollama on another machine (192.168.1.20:11434)');
    expect(provenanceBadge('server-continued', lan)).toBe('continued by Ollama on another machine (192.168.1.20:11434) from browser lookups');
    expect(provenanceBadge('server-fallback', lan)).not.toMatch(/cloud/i);
    // serverModelLocal true wins (a host never makes a local reply sound remote), and a blank host is no host.
    expect(provenanceBadge('server-fallback', { ...lan, serverModelLocal: true })).toBe('answered on your laptop');
    expect(provenanceBadge('server-fallback', { ...lan, serverHost: ' ' })).toBe('answered by Ollama · cloud model');
    // Real cloud models keep "· cloud model".
    expect(provenanceBadge('server-fallback', { serverModelLocal: false, serverProvider: 'Ollama Cloud', serverHost: null })).toBe(
      'answered by Ollama Cloud · cloud model',
    );
  });

  test('server-continued follows the same rule', () => {
    expect(provenanceBadge('server-continued', LOCAL_INFO)).toBe('continued on your laptop from browser lookups');
    expect(provenanceBadge('server-continued', { serverModelLocal: false, serverProvider: 'Google' })).toBe(
      'continued by Google from browser lookups · cloud model',
    );
  });

  test('no server-side label says local, on-device or laptop unless the model is local', () => {
    for (const p of ['server-fallback', 'server-continued', 'unavailable'] as const) {
      for (const info of NOT_LOCAL_INFOS) {
        expect(provenanceBadge(p, info)).not.toMatch(LOCAL_WORDS);
      }
    }
  });

  test('a local server model is never described as cloud, and never as on-device (that is the browser)', () => {
    for (const p of ['server-fallback', 'server-continued'] as const) {
      expect(provenanceBadge(p, LOCAL_INFO)).not.toMatch(/cloud/i);
      expect(provenanceBadge(p, LOCAL_INFO)).not.toContain('on-device');
    }
  });

  test('browser-local states ignore the server model', () => {
    for (const info of [LOCAL_INFO, ...NOT_LOCAL_INFOS]) {
      expect(provenanceBadge('local-with-context', info)).toBe('answered locally · on-device');
      expect(provenanceBadge('local-tools', info)).toBe('answered locally · on-device lookups');
    }
  });
});

describe('legacy dashboard badge (src/dashboard/html.ts) agrees with provenanceBadge', () => {
  const html = getDashboardHtml(0);
  const start = html.indexOf('var PROV_LABELS = ');
  const end = html.indexOf('function stampProv');
  if (start < 0 || end < 0) throw new Error('legacy provenance source not found in dashboard html');
  // eslint-disable-next-line no-new-func
  const legacy = new Function(`${html.slice(start, end)}; return { deriveProv: deriveProv, provLabel: provLabel };`)() as {
    deriveProv: (localAnswered: boolean, hybridPresent: boolean) => ChatProvenance;
    provLabel: (prov: ChatProvenance, srv?: unknown) => string;
  };

  test('embeds the shared labels and no longer says "server fallback"', () => {
    expect(html).toContain(`var PROV_LABELS = ${JSON.stringify(PROVENANCE_LABELS)};`);
    expect(html).not.toContain('server fallback');
  });

  test('every legacy state and server reply renders the same text as the React badge', () => {
    for (const [localAnswered, hybridPresent] of [[true, true], [false, true], [false, false]] as const) {
      const prov = legacy.deriveProv(localAnswered, hybridPresent);
      expect(prov).toBe(deriveChatProvenance({ localAnswered, hybridLayerPresent: hybridPresent }));
      for (const info of [LOCAL_INFO, ...NOT_LOCAL_INFOS]) {
        expect(legacy.provLabel(prov, info)).toBe(provenanceBadge(prov, info));
      }
    }
  });

  test('a cloud reply never gets local wording on the legacy page either', () => {
    for (const info of NOT_LOCAL_INFOS) expect(legacy.provLabel('server-fallback', info)).not.toMatch(LOCAL_WORDS);
    expect(legacy.provLabel('server-fallback', null)).toBe('answered by the server · cloud model');
  });

  test('a failed turn (error, 409 busy, no answer) gets no "answered by" badge', () => {
    const send = html.slice(html.indexOf('async function sendChat'), html.indexOf("chatSend.addEventListener('click'"));
    expect(send).toContain('if (res.ok && data.answer) stampProv(pending, prov, data);');
    const catchBlock = send.slice(send.lastIndexOf('} catch(e) {'));
    expect(catchBlock.slice(0, catchBlock.indexOf('}', 1))).not.toContain('stampProv');
  });
});

describe('React ChatTab: a failed turn gets no provenance badge', () => {
  test('the error message carries no provenance', async () => {
    const src = await Bun.file(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url)).text();
    const errorMsg = src.match(/content: `Error: \$\{errMsg\}`[^}]*\}/);
    expect(errorMsg).not.toBeNull();
    expect(errorMsg![0]).not.toContain('provenance');
  });
});

describe('deriveChatProvenance: browser subagent (spec section 10)', () => {
  test('a subagent answer is local-tools; a bundle answer stays local-with-context', () => {
    expect(
      deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true, localMode: 'subagent', handoffSent: false }),
    ).toBe('local-tools');
    expect(
      deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true, localMode: 'bundle', handoffSent: false }),
    ).toBe('local-with-context');
    // No mode given (every pre-subagent caller) means bundle.
    expect(deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true })).toBe('local-with-context');
  });

  test('a server answer after a handoff WITH a payload is server-continued', () => {
    expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true, handoffSent: true })).toBe(
      'server-continued',
    );
  });

  test('a server answer without a payload keeps the existing rule', () => {
    expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true, handoffSent: false })).toBe(
      'server-fallback',
    );
    expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false, handoffSent: false })).toBe(
      'unavailable',
    );
  });

  test('precedence: a local answer wins over handoffSent; handoffSent wins over layer presence', () => {
    expect(
      deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true, localMode: 'subagent', handoffSent: true }),
    ).toBe('local-tools');
    expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false, handoffSent: true })).toBe(
      'server-continued',
    );
  });
});
