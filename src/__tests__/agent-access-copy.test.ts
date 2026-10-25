import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CHAT_AGENT_ACCESS_LINK,
  CHAT_AGENT_ACCESS_OFF_ANSWER,
  CHAT_AGENT_ACCESS_OFF_NOTICE,
  KILL_SWITCH_HINT,
  KILL_SWITCH_OFF_LINE,
  SETTINGS_TAB_HINT,
} from '../dashboard/ui/src/lib/agentAccessCopy.js';
import { AGENT_ACCESS_HINT } from '../dashboard/ui/src/lib/signInCopy.js';

// NN-09: the Agent access switch gates outside agents (src/mcp/*) AND Wilson's own Chat (src/dashboard/chat.ts). The
// copy must say both, and must not say Chat is left out. src/__tests__/chat-kill-switch.test.ts proves the behaviour.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('Agent access copy', () => {
  test('the switch copy covers outside agents and Wilson\'s own Chat, and never says Chat is not covered', () => {
    for (const copy of [KILL_SWITCH_HINT, KILL_SWITCH_OFF_LINE]) {
      expect(copy).toMatch(/outside/);
      expect(copy).toMatch(/Wilson's own Chat/);
      expect(copy).not.toMatch(/not (covered|turn off)|does not/i);
    }
    expect(SETTINGS_TAB_HINT).toMatch(/Chat/);
    expect(SETTINGS_TAB_HINT).toMatch(/outside agents/);
    expect(AGENT_ACCESS_HINT).toMatch(/Wilson's own Chat/);
  });

  test('the Chat reply and notice say access is off and where to turn it on', () => {
    expect(CHAT_AGENT_ACCESS_OFF_ANSWER).toMatch(/Agent access is off/);
    expect(CHAT_AGENT_ACCESS_OFF_ANSWER).toContain('Settings → Agent access');
    expect(CHAT_AGENT_ACCESS_OFF_NOTICE).toMatch(/Agent access is off/);
    expect(CHAT_AGENT_ACCESS_LINK).toContain('Settings → Agent access');
  });

  test('the chat path consults the switch (if this fails, revisit the copy)', () => {
    const chat = read('../dashboard/chat.ts');
    expect(chat).toContain('isAgentAccessEnabled');
    expect(chat).toContain('mayUseTools');
    const server = read('../dashboard/server.ts');
    expect(server).toMatch(/\/api\/chat\/local[\s\S]{0,600}isAgentAccessEnabled\(\)/);
  });

  test('the bridge panel says the same thing when access is off', () => {
    const bridge = read('../dashboard/webmcp-bridge.ts');
    expect(bridge).toContain(JSON.stringify(KILL_SWITCH_OFF_LINE));
    expect(bridge).not.toContain("does not turn off Wilson's own Chat");
  });

  test('the spec names the same off line', () => {
    expect(read('../../specs/webmcp-security-judge.md')).toContain(KILL_SWITCH_OFF_LINE);
  });
});
