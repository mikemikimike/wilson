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
 * Remember whether `profile` has auth on. Set before that profile's rows are written to the mirror (a sync pull
 * learns both together), so no copy of an auth profile ever sits in the pool without the flag that locks it.
 */
export function recordProfileAuth(storage: MirrorStorage | null, profile: string, authEnabled: boolean): void {
  const current = readAuthProfiles(storage);
  const has = current.includes(profile);
  if (has === authEnabled) return;
  const next = authEnabled ? [...current, profile] : current.filter((p) => p !== profile);
  try {
    if (next.length === 0) storage?.removeItem(MIRROR_AUTH_PROFILES_KEY);
    else storage?.setItem(MIRROR_AUTH_PROFILES_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: nothing was persisted either, so there is no mirror to lock.
  }
}

/**
 * The login check said auth is on. Which profile it is for is not public (GET /api/auth/status names none), so the
 * stored mirror profile is flagged: at worst a profile is locked offline until its next sync pull says otherwise.
 * Nothing here ever clears a flag; only a sync pull, which knows its profile, does.
 */
export function noteAuthEnabled(storage: MirrorStorage | null): void {
  recordProfileAuth(storage, readStoredMirrorProfile(storage), true);
}

/** Offline, with no login: may the app serve the stored profile's mirror? Not when that profile has auth on. */
export function offlineLoginRequired(storage: MirrorStorage | null, hasToken: boolean): boolean {
  if (hasToken) return false;
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
 * Delete each profile's pool directory. A pool that does not exist counts as removed; one still held open (another
 * tab's mirror worker owns its access handles) fails and is reported, and that tab wipes it itself when it sees the
 * session end. Never throws.
 */
export async function removeMirrorPools(root: PoolRoot, profiles: string[]): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const profile of profiles) {
    try {
      await root.removeEntry(poolDirectoryName(profile), { recursive: true });
      removed.push(profile);
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'NotFoundError') removed.push(profile);
      else failed.push(profile);
    }
  }
  return { removed, failed };
}
