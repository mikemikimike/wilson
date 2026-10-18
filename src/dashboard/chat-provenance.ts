/**
 * Per-response chat provenance badges: the exact strings BOTH dashboards show
 * under an answer. Import-free on purpose: the React ChatTab imports it (via
 * ui/src/hybrid/core.ts), and the legacy dashboard (html.ts) embeds
 * PROVENANCE_LABELS into its inline script at render time, so the wording has
 * one source. Pinned by src/__tests__/local-chat-provenance.test.ts.
 *
 * Privacy rule (#167): a badge for a server-answered state may claim local
 * processing ("on your laptop") only when /api/chat reported the server
 * agent's model as local (serverChatModelInfo in chat.ts). False, absent or unknown gets cloud wording, never
 * local wording: understating where ledger rows went is the failure to avoid.
 */

/**
 * Which path actually produced a live chat response. Carried on the live
 * message only — never persisted (no chat-history schema change), so
 * history-loaded messages render with no indicator.
 */
export type ChatProvenance =
  | 'local-with-context' // bundle mode answered
  | 'local-tools' // subagent answered from on-device tool reads
  | 'server-continued' // subagent handed off WITH a payload; the server continued
  | 'server-fallback' // local layer present, server answered without a handoff payload
  | 'unavailable'; // hybrid layer absent / skipped

/** Where the server agent's chat model runs, as POST /api/chat reports it. */
export interface ServerModelInfo {
  /** True only when the server agent's chat model and every task model its tools call run on this machine. Absent = unknown = cloud. */
  serverModelLocal?: boolean;
  /** Display name of the cloud provider the model routes to (e.g. 'Anthropic'); null/absent when unknown or local. */
  serverProvider?: string | null;
  /**
   * Set when the model is a local runtime on another machine (a LAN Ollama, OLLAMA_BASE_URL): that machine's host.
   * Changes only the wording ("on another machine"); such a reply is still not local.
   */
  serverHost?: string | null;
}

/**
 * Every badge string. `{who}` in the cloud templates is the provider's display
 * name, or `unknownServer` when the reply did not name one.
 */
export const PROVENANCE_LABELS = {
  'local-with-context': 'answered locally · on-device',
  'local-tools': 'answered locally · on-device lookups',
  'unavailable': 'server agent',
  serverLocal: 'answered on your laptop',
  serverCloud: 'answered by {who} · cloud model',
  serverContinuedLocal: 'continued on your laptop from browser lookups',
  serverContinuedCloud: 'continued by {who} from browser lookups · cloud model',
  serverOtherMachine: 'answered by {who} on another machine ({host})',
  serverContinuedOtherMachine: 'continued by {who} on another machine ({host}) from browser lookups',
  unknownServer: 'the server',
} as const;

function cloudLabel(template: string, info: ServerModelInfo): string {
  const who = typeof info.serverProvider === 'string' && info.serverProvider.trim() ? info.serverProvider.trim() : PROVENANCE_LABELS.unknownServer;
  return template.replace('{who}', who);
}

/** The other machine's host, when the reply names one; otherwise the cloud wording applies. */
function otherMachine(info: ServerModelInfo): string | null {
  return typeof info.serverHost === 'string' && info.serverHost.trim() ? info.serverHost.trim() : null;
}

/** Wording for a server model that is not local: another machine when the reply says so, else cloud. */
function notLocalLabel(cloudTemplate: string, otherTemplate: string, info: ServerModelInfo): string {
  const host = otherMachine(info);
  return host ? cloudLabel(otherTemplate, info).replace('{host}', host) : cloudLabel(cloudTemplate, info);
}

/**
 * Badge text for a response. Browser-local states ignore `info`; the two
 * server-answered states say "on your laptop" only for serverModelLocal ===
 * true, "on another machine (<host>)" for a LAN runtime (serverHost), and
 * "cloud model" otherwise. 'unavailable' stays neutral ("server agent"): the hybrid layer was
 * absent, and the badge makes no processing-location claim.
 */
export function provenanceBadge(p: ChatProvenance, info: ServerModelInfo = {}): string {
  const local = info.serverModelLocal === true;
  if (p === 'server-fallback') {
    return local ? PROVENANCE_LABELS.serverLocal : notLocalLabel(PROVENANCE_LABELS.serverCloud, PROVENANCE_LABELS.serverOtherMachine, info);
  }
  if (p === 'server-continued') {
    return local
      ? PROVENANCE_LABELS.serverContinuedLocal
      : notLocalLabel(PROVENANCE_LABELS.serverContinuedCloud, PROVENANCE_LABELS.serverContinuedOtherMachine, info);
  }
  return PROVENANCE_LABELS[p];
}

/**
 * Badge per state with no server model information: the cloud-safe defaults.
 * Rendering code calls provenanceBadge() with the reply's ServerModelInfo.
 */
export const PROVENANCE_BADGES: Record<ChatProvenance, string> = {
  'local-with-context': provenanceBadge('local-with-context'),
  'local-tools': provenanceBadge('local-tools'),
  'server-continued': provenanceBadge('server-continued'),
  'server-fallback': provenanceBadge('server-fallback'),
  'unavailable': provenanceBadge('unavailable'),
};
