/**
 * Words for the Agent access switch (Settings → Agent access, the Settings tab hint). Pure, so
 * src/__tests__/agent-access-copy.test.ts can pin them. The switch (isAgentAccessEnabled) gates
 * only outside agents, through src/mcp/*; Wilson's own Chat agent (POST /api/chat) never checks
 * it, so the copy must not promise that it stops every AI agent (NN-09).
 */

export const KILL_SWITCH_HINT =
  "Master switch for outside agents: when off, no MCP client or other outside AI agent can use any Wilson tool. Wilson's own Chat tab is not covered by this switch.";

export const KILL_SWITCH_OFF_LINE =
  "Agent access is off. No tools are exposed to any outside agent or MCP client. This does not turn off Wilson's own Chat.";

export const SETTINGS_TAB_HINT =
  'Preferences, profiles and Agent access, the master switch for what outside AI agents and MCP clients may do in Wilson.';
