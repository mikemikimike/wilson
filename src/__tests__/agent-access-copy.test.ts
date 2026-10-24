import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KILL_SWITCH_HINT, KILL_SWITCH_OFF_LINE, SETTINGS_TAB_HINT } from '../dashboard/ui/src/lib/agentAccessCopy.js';

// NN-09: the Agent access switch gates only outside agents (src/mcp/*). Wilson's own Chat agent never checks it,
// so the copy must not say it stops every AI agent.

describe('Agent access copy', () => {
  test('scopes the switch to outside agents and says Chat is not covered', () => {
    for (const copy of [KILL_SWITCH_HINT, KILL_SWITCH_OFF_LINE]) {
      expect(copy).not.toMatch(/no AI agent\b/i);
      expect(copy).not.toMatch(/to any agent\b/);
      expect(copy).toMatch(/outside/);
      expect(copy).toMatch(/Wilson's own Chat/);
    }
    expect(SETTINGS_TAB_HINT).toMatch(/outside AI agents/);
  });

  test('the chat path still does not consult the switch (if this fails, revisit the copy)', () => {
    const chat = readFileSync(new URL('../dashboard/chat.ts', import.meta.url), 'utf8');
    expect(chat).not.toContain('isAgentAccessEnabled');
  });

  test('the bridge panel says the same thing when access is off', () => {
    const bridge = readFileSync(new URL('../dashboard/webmcp-bridge.ts', import.meta.url), 'utf8');
    expect(bridge).toContain(JSON.stringify(KILL_SWITCH_OFF_LINE));
  });
});
