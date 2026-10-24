/**
 * In-tab chat model consent (NN-01). The in-tab model's weights come from
 * huggingface.co, so nothing may start loading them (no Hub metadata request,
 * no weight download, no worker model load) until the user clicks the opt-in
 * in Chat. Same pattern as the pre-labeler (prelabel/controller.ts): a
 * localStorage key with a revision, read in try/catch, set only by an explicit
 * click and cleared by "Turn off".
 *
 * The revision is the model repo, so a different in-tab model (another size,
 * another download) asks again.
 *
 * Pure and import-light: both the React app bundle and the prebuilt hybrid
 * chunk import it (the chunk re-checks the key on every turn, so the legacy
 * dashboard is gated too), and bun tests drive it with a fake storage.
 */
import { formatDownloadSize } from './load-progress.js';

export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const inTabOptInKey = (revision: string) => `wilson-intab-chat-optin:v1:${revision}`;

/** `localStorage`, or null when it is blocked or absent (private mode, policy, bun test). */
export function browserLocalStorage(): ConsentStorage | null {
  try {
    return (globalThis as { localStorage?: ConsentStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function isInTabOptedIn(storage: ConsentStorage | null | undefined, revision: string | null | undefined): boolean {
  if (!revision) return false;
  try {
    return storage?.getItem(inTabOptInKey(revision)) === '1';
  } catch {
    return false;
  }
}

/** The opt-in click. False when storage is blocked: the choice then lasts only for this page (see the hook). */
export function setInTabOptIn(storage: ConsentStorage | null | undefined, revision: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(inTabOptInKey(revision), '1');
    return true;
  } catch {
    return false;
  }
}

/** "Turn off": clear the key (a blocked removeItem falls back to overwriting it). */
export function clearInTabOptIn(storage: ConsentStorage | null | undefined, revision: string): void {
  try {
    if (!storage) return;
    if (typeof storage.removeItem === 'function') storage.removeItem(inTabOptInKey(revision));
    else storage.setItem(inTabOptInKey(revision), '0');
  } catch {
    /* blocked storage: nothing stored, nothing to clear */
  }
}

/** Reason a turn skipped the in-tab model because the user has not opted in. Never an error bubble. */
export const NOT_OPTED_IN = 'not-opted-in' as const;

/**
 * Run `attempt` (the chunk's tryLocal) only when the user opted in for this
 * model. Otherwise resolve {ok:false, reason:'not-opted-in'} at once, without
 * touching the chunk, so the turn goes to the server exactly as any other
 * hybrid failure does.
 */
export async function tryLocalIfOptedIn<R>(
  optedIn: () => Promise<boolean> | boolean,
  attempt: () => Promise<R>,
): Promise<R | { ok: false; reason: typeof NOT_OPTED_IN }> {
  let ok = false;
  try {
    ok = await optedIn();
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: NOT_OPTED_IN };
  return attempt();
}

/** Copy for the Chat opt-in (pinned by src/__tests__/hybrid-consent.test.ts). */
export interface InTabOptInCopy {
  text: string;
  accept: string;
  dismiss: string;
}

/** Display name for the server's chat model: the configured id without a provider prefix ('ollama:gemma4:12b' -> 'gemma4:12b'). */
export function serverModelLabel(raw: string | null | undefined): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return "the server's model";
  const m = /^(ollama|transformers|openrouter|litellm):(.+)$/i.exec(id);
  return m ? m[2] : id;
}

export function inTabOptInCopy(downloadSize: string | null | undefined, serverModel: string | null | undefined): InTabOptInCopy {
  const size = formatDownloadSize(downloadSize);
  const what = size ? `a one-time ${size} download` : 'a one-time download';
  return {
    text: `Run chat on this device? It needs ${what} from huggingface.co, then runs in this tab. Until then, questions go to ${serverModelLabel(serverModel)}.`,
    accept: size ? `Download ${size}` : 'Download',
    dismiss: 'Not now',
  };
}

export const IN_TAB_ON_LABEL = 'In-tab model on: chat runs on this device.';
export const IN_TAB_TURN_OFF = 'Turn off';
