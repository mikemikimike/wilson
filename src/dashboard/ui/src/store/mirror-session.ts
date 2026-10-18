// ── The offline mirror and the login session ─────────────────────────────────
//
// The mirror keeps a copy of the ledger in this browser (an OPFS pool per
// profile, see wa-sqlite-adapter.ts). For a profile with auth on, that copy is
// as private as the server's, so:
//   - it is wiped whenever the login session ends (logout, a 401, another
//     tab's logout): every pool the session could have filled, plus the few
//     storage entries that hold ledger-derived text;
//   - it is never served without a login, even offline. Deciding that offline
//     needs one fact the server is not there to give: "auth is on for this
//     profile". That is the only thing persisted here (profile names, no data).
//
// Pure apart from the injected storage and directory handles, so bun tests
// can import it (mirror-client.ts cannot be: it needs a browser worker).

/** localStorage: the profile whose mirror was opened last (the one served offline). */
export const MIRROR_PROFILE_KEY = 'wilson_mirror_profile';
/** localStorage: JSON array of the profiles last seen with auth on. Names only. */
export const MIRROR_AUTH_PROFILES_KEY = 'wilson_mirror_auth_profiles';
/** localStorage: whose login the mirror was last unlocked for (a user id, or "none" for no login). An id only. */
export const MIRROR_OWNER_KEY = 'wilson_mirror_owner';
/** The profile the mirror opens when none was stored. */
export const DEFAULT_MIRROR_PROFILE = 'default';

/**
 * Storage entries outside the pool that hold ledger-derived text: the chat composer's recent mentions
 * (merchant, category and entity names; typeahead.ts RECENT_MENTIONS_KEY) and the pre-labeller's per-transaction
 * score cache (prelabel/core.ts cacheKey). Consent flags and capability verdicts are not ledger data and stay.
 */
export const LEDGER_LOCAL_KEYS = ['wilson.recentMentions'] as const;
export const LEDGER_SESSION_PREFIXES = ['wilson-prelabel:v1:'] as const;

/** The part of Storage read and written here (localStorage, or a test's plain object). */
export interface MirrorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A Storage whose keys can be listed, for prefix removal. */
export interface ListableStorage extends MirrorStorage {
  readonly length: number;
  key(index: number): string | null;
}

/** Per-profile OPFS pool directory (per-profile mirror keying). */
export function poolDirectoryName(profile: string): string {
  return `wilson-mirror-${encodeURIComponent(profile)}`;
}

export function readStoredMirrorProfile(storage: MirrorStorage | null): string {
  try {
    return storage?.getItem(MIRROR_PROFILE_KEY) || DEFAULT_MIRROR_PROFILE;
  } catch {
    return DEFAULT_MIRROR_PROFILE;
  }
}

export function readAuthProfiles(storage: MirrorStorage | null): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(MIRROR_AUTH_PROFILES_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The login the mirror was last unlocked for (lib/authSession.ts MirrorOwner), kept across reloads so a page that
 * opens for another login (one made in the legacy dashboard, say) still wipes the old one's copy first. A user id,
 * null for no login, undefined when unknown or unreadable.
 */
export function readMirrorOwner(storage: MirrorStorage | null): number | null | undefined {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(MIRROR_OWNER_KEY);
  } catch {
    return undefined;
  }
  if (raw === 'none') return null;
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export function writeMirrorOwner(storage: MirrorStorage | null, owner: number | null | undefined): void {
  try {
    if (owner === undefined) storage?.removeItem(MIRROR_OWNER_KEY);
    else storage?.setItem(MIRROR_OWNER_KEY, owner === null ? 'none' : String(owner));
  } catch {
    // Blocked storage: the gate still remembers it for this page.
  }
}

/**
 * Remember whether `profile` has auth on. Set before that profile's rows are written to the mirror (a sync pull
 * learns both together), so no copy of an auth profile ever sits in the pool without the flag that locks it.
 *
 * The first answer this browser records speaks for `profile` only. A mirror profile stored before the flags existed
 * (a pre-0.10 pool, possibly another profile's) is flagged along with it, so writing the list cannot unlock that
 * pool offline; a later pull for that profile clears it if its auth is off.
 */
export function recordProfileAuth(storage: MirrorStorage | null, profile: string, authEnabled: boolean): void {
  const first = !flagsWritten(storage);
  const current = readAuthProfiles(storage);
  const has = current.includes(profile);
  if (has === authEnabled && !first) return;
  const next = authEnabled ? [...current, profile] : current.filter((p) => p !== profile);
  const stored = readStoredMirrorProfile(storage);
  if (first && mirrorProfileStored(storage) && stored !== profile && !next.includes(stored)) next.push(stored);
  try {
    // An empty list is still written: its absence means "never asked" (offlineLoginRequired).
    storage?.setItem(MIRROR_AUTH_PROFILES_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: nothing was persisted either, so there is no mirror to lock.
  }
}

/** Whether this browser has recorded any auth answer yet (the list, even empty, is written). False when unreadable. */
function flagsWritten(storage: MirrorStorage | null): boolean {
  try {
    return storage?.getItem(MIRROR_AUTH_PROFILES_KEY) != null;
  } catch {
    return false;
  }
}

/** Whether a mirror profile was ever stored (written after each successful sync pull, before and since the flags). */
function mirrorProfileStored(storage: MirrorStorage | null): boolean {
  try {
    return storage?.getItem(MIRROR_PROFILE_KEY) != null;
  } catch {
    return false;
  }
}

/**
 * The login check said auth is on. Which profile it is for is not public (GET /api/auth/status names none), so the
 * stored mirror profile is flagged: at worst a profile is locked offline until its next sync pull says otherwise.
 *
 * An "auth off" answer is not recorded at all: it is the server's active profile's, which need not be the stored
 * mirror profile (pools are per profile), so taking it as an answer could unlock another profile's copy offline.
 * Nothing here ever clears a flag or settles the list; only a sync pull, which knows its profile, does.
 */
export function noteAuthEnabled(storage: MirrorStorage | null): void {
  recordProfileAuth(storage, readStoredMirrorProfile(storage), true);
}

/**
 * Offline, with no login: must the login form show instead of the stored profile's mirror? Yes when that profile has
 * auth on, and when a mirror was synced before this browser ever recorded an auth answer (a pool kept from before
 * the flags existed may belong to an auth profile; the first sync pull settles it). A fresh browser with no mirror,
 * and profiles known to be without auth, keep today's offline behaviour.
 *
 * A stored token is taken as a login: offline, a revoked or expired token cannot be told from a valid one, and the
 * first check that reaches the server ends that session (and wipes the mirror) if it is dead.
 */
export function offlineLoginRequired(storage: MirrorStorage | null, hasToken: boolean): boolean {
  if (hasToken) return false;
  if (!flagsWritten(storage)) return mirrorProfileStored(storage);
  return readAuthProfiles(storage).includes(readStoredMirrorProfile(storage));
}

/**
 * The pools a session that just ended could have filled: the open one, the stored one, and every profile flagged
 * with auth on (the token is one per browser, so when it is gone none of them has a login).
 */
export function profilesToWipe(storage: MirrorStorage | null, openProfile: string | null): string[] {
  const all = [openProfile, readStoredMirrorProfile(storage), ...readAuthProfiles(storage)];
  return [...new Set(all.filter((p): p is string => typeof p === 'string' && p.length > 0))];
}

/** Remove the ledger-derived entries outside the pool. Never throws. */
export function clearLedgerStorage(local: MirrorStorage | null, session: ListableStorage | null): void {
  for (const key of LEDGER_LOCAL_KEYS) {
    try {
      local?.removeItem(key);
    } catch {
      // Blocked storage holds nothing.
    }
  }
  try {
    if (!session) return;
    const doomed: string[] = [];
    for (let i = 0; i < session.length; i++) {
      const key = session.key(i);
      if (key && LEDGER_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) doomed.push(key);
    }
    for (const key of doomed) session.removeItem(key);
  } catch {
    // Blocked storage holds nothing.
  }
}

/** The slice of FileSystemDirectoryHandle (the OPFS root) used to delete pools. */
export interface PoolRoot {
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * Backoff for a pool this tab's own worker held until it was just terminated: termination releases the worker's
 * access handles asynchronously, so for a moment the directory still reads as held.
 */
export const POOL_RELEASE_RETRY_MS = [50, 100, 200, 400] as const;

export interface RemovePoolsOptions {
  /** Waits before each retry of a held pool (NoModificationAllowedError). None by default: another tab's hold lasts. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete each profile's pool directory. A pool that does not exist counts as removed; one still held open (another
 * tab's mirror worker owns its access handles) fails and is reported, and that tab wipes it itself when it sees the
 * session end. With `retryDelaysMs`, a held pool is tried again after each delay first. Never throws.
 */
export async function removeMirrorPools(
  root: PoolRoot,
  profiles: string[],
  { retryDelaysMs = [], sleep = defaultSleep }: RemovePoolsOptions = {},
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const profile of profiles) {
    for (let attempt = 0; ; attempt++) {
      try {
        await root.removeEntry(poolDirectoryName(profile), { recursive: true });
        removed.push(profile);
        break;
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'NotFoundError') {
          removed.push(profile);
          break;
        }
        if (name === 'NoModificationAllowedError' && attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]!);
          continue;
        }
        failed.push(profile);
        break;
      }
    }
  }
  return { removed, failed };
}
