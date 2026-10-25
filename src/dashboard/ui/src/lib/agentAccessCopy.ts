/**
 * Words for the Agent access switch (Settings → Agent access, the Settings tab hint, the Chat tab notice). Pure, so
 * src/__tests__/agent-access-copy.test.ts can pin them. The switch (isAgentAccessEnabled) gates outside agents
 * through src/mcp/*, and Wilson's own Chat in the dashboard too: the server chat (src/dashboard/chat.ts, every tool
 * call, "/categorize" and pending approval cards) and the in-tab model (it does not run, and POST /api/chat/local
 * refuses its answers). The copy says exactly that much and no more (NN-09): it names the dashboard's Chat, not the
 * terminal app.
 */

export const KILL_SWITCH_HINT =
  "Master switch for AI agents in this dashboard: when off, Wilson's own Chat cannot read or change your data, and no MCP client or other outside agent can use any Wilson tool.";

export const KILL_SWITCH_OFF_LINE =
  "Agent access is off. Wilson's own Chat cannot use your data, and no tools are exposed to any outside agent or MCP client.";

export const SETTINGS_TAB_HINT =
  "Preferences, profiles and Agent access, the master switch for what AI agents may do in Wilson: its own Chat, outside agents and MCP clients.";

/** The server's reply to a chat turn while the switch is off (src/dashboard/chat.ts). No model is called for it. */
export const CHAT_AGENT_ACCESS_OFF_ANSWER =
  "Agent access is off, so Wilson's Chat can't use your data. Nothing was read or changed. Turn it on in Settings → Agent access.";

/** The Chat tab's notice by the composer while the switch is off, shown before anything is sent. */
export const CHAT_AGENT_ACCESS_OFF_NOTICE =
  "Agent access is off, so Wilson's Chat can't read or change your data. Questions get a reply saying so, not an answer. /help still works.";

/** The notice's link to the switch. */
export const CHAT_AGENT_ACCESS_LINK = 'Open Settings → Agent access';
