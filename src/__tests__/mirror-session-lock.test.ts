import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIRROR_PROFILE,
  LEDGER_LOCAL_KEYS,
  LEDGER_SESSION_PREFIXES,
  MIRROR_AUTH_PROFILES_KEY,
  MIRROR_OWNER_KEY,
  MIRROR_PROFILE_KEY,
  POOL_RELEASE_RETRY_MS,
  clearLedgerStorage,
  listMirrorPoolProfiles,
  noteAuthEnabled,
  offlineLoginRequired,
  poolDirectoryName,
  profilesToWipe,
  readAuthProfiles,
  readMirrorOwner,
  readStoredMirrorProfile,
  recordProfileAuth,
  removeMirrorPools,
  writeMirrorOwner,
  type ListableStorage,
  type PoolRoot,
} from '../dashboard/ui/src/store/mirror-session.js';
import { RECENT_MENTIONS_KEY } from '../dashboard/ui/src/lib/typeahead.js';
import { cacheKey } from '../dashboard/ui/src/prelabel/core.js';
import { optInKey } from '../dashboard/ui/src/prelabel/controller.js';

/**
 * The offline mirror and the login session (ui/src/store/mirror-session.ts, wired by store/mirror-client.ts and
 * components/AuthGate.tsx): the copy of the ledger this browser keeps is wiped when the session ends, and never
 * served offline for a profile with auth on and no login. mirror-client.ts needs a browser worker, so its wiring is
 * pinned by source below; the decisions themselves are tested directly.
 */

function memoryStorage(initial: Record<string, string> = {}): ListableStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const throwingStorage: ListableStorage = {
  length: 0,
  key: () => { throw new Error('SecurityError'); },
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

describe('the "auth is on" flag', () => {
  test('per profile, names only, set and cleared by what a sync pull learns', () => {
    const storage = memoryStorage();
    recordProfileAuth(storage, 'household', true);
    recordProfileAuth(storage, 'business', true);
    expect(readAuthProfiles(storage)).toEqual(['household', 'business']);
    expect(storage.data.get(MIRROR_AUTH_PROFILES_KEY)).toBe('["household","business"]');
    recordProfileAuth(storage, 'household', false);
    expect(readAuthProfiles(storage)).toEqual(['business']);
    recordProfileAuth(storage, 'business', false);
    // Emptied, not removed: the list's absence means "never asked" (see the upgrade case below).
    expect(storage.data.get(MIRROR_AUTH_PROFILES_KEY)).toBe('[]');
    const fresh = memoryStorage();
    recordProfileAuth(fresh, 'household', false);
    expect(fresh.data.get(MIRROR_AUTH_PROFILES_KEY)).toBe('[]');
  });

  test("the first answer speaks for its own profile only: a pre-flags mirror profile stays flagged", () => {
    // A 0.9 browser's stored mirror is "business"; the first pull this version makes is for "household".
    const upgraded = memoryStorage({ [MIRROR_PROFILE_KEY]: 'business' });
    recordProfileAuth(upgraded, 'household', false);
    expect(readAuthProfiles(upgraded)).toEqual(['business']);
    expect(offlineLoginRequired(upgraded, false)).toBe(true);
    // A pull for "business" itself settles it.
    recordProfileAuth(upgraded, 'business', false);
    expect(readAuthProfiles(upgraded)).toEqual([]);
    expect(offlineLoginRequired(upgraded, false)).toBe(false);
    const upgradedOn = memoryStorage({ [MIRROR_PROFILE_KEY]: 'business' });
    recordProfileAuth(upgradedOn, 'household', true);
    expect(readAuthProfiles(upgradedOn)).toEqual(['household', 'business']);
    // Once the list exists, later answers touch only their own profile.
    recordProfileAuth(upgradedOn, 'other', false);
    expect(readAuthProfiles(upgradedOn)).toEqual(['household', 'business']);
  });

  test('the gate flags the stored mirror profile (or the default one) when the status check says auth is on', () => {
    const fresh = memoryStorage();
    noteAuthEnabled(fresh);
    expect(readAuthProfiles(fresh)).toEqual([DEFAULT_MIRROR_PROFILE]);
    const stored = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household' });
    noteAuthEnabled(stored);
    noteAuthEnabled(stored);
    expect(readAuthProfiles(stored)).toEqual(['household']);
  });

  test('garbage or blocked storage reads as no flags and never throws', () => {
    expect(readAuthProfiles(memoryStorage({ [MIRROR_AUTH_PROFILES_KEY]: '{not json' }))).toEqual([]);
    expect(readAuthProfiles(memoryStorage({ [MIRROR_AUTH_PROFILES_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readAuthProfiles(memoryStorage({ [MIRROR_AUTH_PROFILES_KEY]: '["a",2]' }))).toEqual(['a']);
    expect(readAuthProfiles(throwingStorage)).toEqual([]);
    expect(readStoredMirrorProfile(throwingStorage)).toBe(DEFAULT_MIRROR_PROFILE);
    expect(() => recordProfileAuth(throwingStorage, 'p', true)).not.toThrow();
  });
});

describe('the mirror owner (whose login it was last unlocked for)', () => {
  test('a user id, "none" for no login, or nothing; survives a reload as an id only', () => {
    const storage = memoryStorage();
    expect(readMirrorOwner(storage)).toBeUndefined();
    writeMirrorOwner(storage, 7);
    expect(storage.data.get(MIRROR_OWNER_KEY)).toBe('7');
    expect(readMirrorOwner(storage)).toBe(7);
    writeMirrorOwner(storage, null);
    expect(storage.data.get(MIRROR_OWNER_KEY)).toBe('none');
    expect(readMirrorOwner(storage)).toBeNull();
    writeMirrorOwner(storage, undefined);
    expect(storage.data.has(MIRROR_OWNER_KEY)).toBe(false);
  });

  test('garbage or blocked storage reads as unknown and never throws', () => {
    expect(readMirrorOwner(memoryStorage({ [MIRROR_OWNER_KEY]: 'admin' }))).toBeUndefined();
    expect(readMirrorOwner(memoryStorage({ [MIRROR_OWNER_KEY]: '-1' }))).toBeUndefined();
    expect(readMirrorOwner(throwingStorage)).toBeUndefined();
    expect(() => writeMirrorOwner(throwingStorage, 1)).not.toThrow();
  });
});

describe('offlineLoginRequired', () => {
  const flagged = () => memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '["household"]' });

  test('the stored profile has auth on and there is no login: the mirror stays shut', () => {
    expect(offlineLoginRequired(flagged(), false)).toBe(true);
  });

  test('a stored login (the server cannot be asked offline) opens it', () => {
    expect(offlineLoginRequired(flagged(), true)).toBe(false);
  });

  test("profiles without auth keep today's offline behaviour", () => {
    expect(offlineLoginRequired(memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '[]' }), false)).toBe(false);
    expect(offlineLoginRequired(memoryStorage({ [MIRROR_PROFILE_KEY]: 'other', [MIRROR_AUTH_PROFILES_KEY]: '["household"]' }), false)).toBe(false);
    // A fresh browser has no mirror to protect.
    expect(offlineLoginRequired(memoryStorage(), false)).toBe(false);
    expect(offlineLoginRequired(throwingStorage, false)).toBe(false);
  });

  test('a mirror synced before the flags existed stays shut until a sync pull for its profile says otherwise', () => {
    const upgraded = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household' });
    expect(offlineLoginRequired(upgraded, false)).toBe(true);
    expect(offlineLoginRequired(upgraded, true)).toBe(false);
    recordProfileAuth(upgraded, 'household', false);
    expect(offlineLoginRequired(upgraded, false)).toBe(false);
    const upgradedAuth = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household' });
    noteAuthEnabled(upgradedAuth);
    expect(offlineLoginRequired(upgradedAuth, false)).toBe(true);
  });

  test("an \"auth off\" status check (the server's active profile, maybe not the mirror's) never unlocks a copy", () => {
    // The status route names no profile. With per-profile pools, the "off" may be another profile's: the gate
    // records only "on", so the pre-flags mirror stays shut until its own sync pull.
    const gate = readFileSync(join(import.meta.dir, '../dashboard/ui/src/components/AuthGate.tsx'), 'utf8');
    expect(gate).toContain("if (check.kind === 'status' && check.status.authEnabled) noteAuthEnabled(storage);");
    expect(gate).not.toContain('noteAuthStatus');
    const source = readFileSync(join(import.meta.dir, '../dashboard/ui/src/store/mirror-session.ts'), 'utf8');
    expect(source).not.toContain("setItem(MIRROR_AUTH_PROFILES_KEY, '[]')");
    expect(offlineLoginRequired(memoryStorage({ [MIRROR_PROFILE_KEY]: 'household' }), false)).toBe(true);
  });
});

describe('what a wipe removes', () => {
  test('the open pool, the stored one and every auth profile, once each', () => {
    const storage = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '["household","business"]' });
    expect(profilesToWipe(storage, 'demo')).toEqual(['demo', 'household', 'business']);
    expect(profilesToWipe(memoryStorage(), null)).toEqual([DEFAULT_MIRROR_PROFILE]);
  });

  test('every pool found on disk goes too: a 0.8/0.9 browser synced profiles it never recorded', async () => {
    const names = [
      poolDirectoryName('household'),
      poolDirectoryName('old-business'),
      poolDirectoryName('my/profile'),
      'wilson-mirror-%E0%A4', // not a name the VFS makes (does not decode)
      'wilson-mirror-a b', // nor this (poolDirectoryName('a b') is wilson-mirror-a%20b)
      'wilson-mirror-',
      'unrelated',
    ];
    const root: PoolRoot = {
      async removeEntry() {},
      async *keys() { yield* names; },
    };
    const onDisk = await listMirrorPoolProfiles(root);
    expect(onDisk).toEqual(['household', 'old-business', 'my/profile']);
    const storage = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '[]' });
    expect(profilesToWipe(storage, 'household', onDisk)).toEqual(['household', 'old-business', 'my/profile']);
  });

  test('a root that cannot be listed yields what was read; no root or no keys() yields nothing', async () => {
    const failing: PoolRoot = {
      async removeEntry() {},
      async *keys() {
        yield poolDirectoryName('a');
        throw new Error('NotAllowedError');
      },
    };
    expect(await listMirrorPoolProfiles(failing)).toEqual(['a']);
    expect(await listMirrorPoolProfiles(null)).toEqual([]);
    expect(await listMirrorPoolProfiles({ async removeEntry() {} })).toEqual([]);
  });

  test('the ledger-derived entries outside the pool go; consent and capability flags stay', () => {
    const local = memoryStorage({
      [RECENT_MENTIONS_KEY]: '[{"type":"merchant","label":"Blue Bottle"}]',
      [optInKey('rev1')]: '1',
      [MIRROR_PROFILE_KEY]: 'household',
      [MIRROR_AUTH_PROFILES_KEY]: '["household"]',
    });
    const scores = cacheKey({ profile: 'household', labelSetVersion: 'l1', modelId: 'm', revision: 'r', templateVersion: 't' });
    const session = memoryStorage({ [scores]: '{"v":1,"rows":[]}', 'wilson-hybrid-capability': '{}', other: 'x' });
    clearLedgerStorage(local, session);
    expect([...local.data.keys()].sort()).toEqual([MIRROR_AUTH_PROFILES_KEY, MIRROR_PROFILE_KEY, optInKey('rev1')].sort());
    expect([...session.data.keys()].sort()).toEqual(['other', 'wilson-hybrid-capability']);
  });

  test('the key lists match the modules that write them', () => {
    expect(LEDGER_LOCAL_KEYS).toContain(RECENT_MENTIONS_KEY);
    const scores = cacheKey({ profile: 'p', labelSetVersion: 'l', modelId: 'm', revision: 'r', templateVersion: 't' });
    expect(LEDGER_SESSION_PREFIXES.some((prefix) => scores.startsWith(prefix))).toBe(true);
  });

  test('blocked storage never throws', () => {
    expect(() => clearLedgerStorage(throwingStorage, throwingStorage)).not.toThrow();
    expect(() => clearLedgerStorage(null, null)).not.toThrow();
  });
});

describe('removeMirrorPools', () => {
  function fakeRoot(entries: string[], held: string[] = []): PoolRoot & { entries: Set<string>; calls: unknown[] } {
    const set = new Set(entries);
    const calls: unknown[] = [];
    return {
      entries: set,
      calls,
      async removeEntry(name, options) {
        calls.push([name, options]);
        if (held.includes(name)) throw Object.assign(new Error('held'), { name: 'NoModificationAllowedError' });
        if (!set.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        set.delete(name);
      },
    };
  }

  test('deletes each profile pool recursively; a pool that is not there counts as removed', async () => {
    const root = fakeRoot([poolDirectoryName('household'), poolDirectoryName('demo'), 'unrelated']);
    const result = await removeMirrorPools(root, ['household', 'never-synced']);
    expect(result).toEqual({ removed: ['household', 'never-synced'], failed: [] });
    expect([...root.entries].sort()).toEqual([poolDirectoryName('demo'), 'unrelated'].sort());
    expect(root.calls[0]).toEqual([poolDirectoryName('household'), { recursive: true }]);
  });

  test("a pool another tab's worker holds is reported, and the rest still go", async () => {
    const root = fakeRoot([poolDirectoryName('a'), poolDirectoryName('b')], [poolDirectoryName('a')]);
    expect(await removeMirrorPools(root, ['a', 'b'])).toEqual({ removed: ['b'], failed: ['a'] });
  });

  // The tab's own worker was just terminated: Chromium releases its access handles a moment later, so for a while
  // the directory still answers NoModificationAllowedError.
  function releasingRoot(name: string, heldFor: number): PoolRoot & { attempts: number; gone: boolean } {
    const root = {
      attempts: 0,
      gone: false,
      async removeEntry(entry: string) {
        if (entry !== name) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        root.attempts++;
        if (root.attempts <= heldFor) throw Object.assign(new Error('held'), { name: 'NoModificationAllowedError' });
        root.gone = true;
      },
    };
    return root;
  }

  test('with a backoff, a pool still being released is retried until it goes', async () => {
    const root = releasingRoot(poolDirectoryName('household'), 3);
    const waits: number[] = [];
    const result = await removeMirrorPools(root, ['household'], {
      retryDelaysMs: POOL_RELEASE_RETRY_MS,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(result).toEqual({ removed: ['household'], failed: [] });
    expect(root.gone).toBe(true);
    expect(waits).toEqual([50, 100, 200]);
  });

  test('the backoff is bounded: a pool held past it is reported', async () => {
    const root = releasingRoot(poolDirectoryName('household'), 99);
    const waits: number[] = [];
    const result = await removeMirrorPools(root, ['household'], { retryDelaysMs: [1, 2], sleep: async (ms) => { waits.push(ms); } });
    expect(result).toEqual({ removed: [], failed: ['household'] });
    expect(root.attempts).toBe(3);
    expect(waits).toEqual([1, 2]);
  });

  test('without a backoff (another tab holds the pool), and for other errors, there is one try', async () => {
    const held = releasingRoot(poolDirectoryName('a'), 1);
    expect(await removeMirrorPools(held, ['a'], { sleep: async () => { throw new Error('no wait expected'); } })).toEqual({ removed: [], failed: ['a'] });
    expect(held.attempts).toBe(1);
    let calls = 0;
    const broken: PoolRoot = { async removeEntry() { calls++; throw Object.assign(new Error('x'), { name: 'SecurityError' }); } };
    expect(await removeMirrorPools(broken, ['a'], { retryDelaysMs: [1, 1], sleep: async () => {} })).toEqual({ removed: [], failed: ['a'] });
    expect(calls).toBe(1);
  });

  test('pool names are the ones the VFS opens (unchanged from before the move)', () => {
    expect(poolDirectoryName('default')).toBe('wilson-mirror-default');
    expect(poolDirectoryName('my/profile')).toBe('wilson-mirror-my%2Fprofile');
  });
});

describe('wiring (source pins: these modules need a browser worker or React)', () => {
  const uiSrc = join(import.meta.dir, '../dashboard/ui/src');
  const read = (rel: string) => readFileSync(join(uiSrc, rel), 'utf8');
  const client = read('store/mirror-client.ts');
  const worker = read('store/mirror-worker.ts');
  const gate = read('components/AuthGate.tsx');
  const settings = read('tabs/SettingsTab.tsx');
  const adapter = read('store/wa-sqlite-adapter.ts');

  test('the mirror starts locked: nothing opens, syncs or serves before the gate unlocks it', () => {
    expect(client).toContain('let locked = true;');
    // (A wipe in flight is waited out first, then the lock is checked.)
    expect(client).toMatch(/export function initMirror\(\): Promise<MirrorState> \{\n {2}if \(wiping\) return wiping\.then\(\(\) => initMirror\(\)\);\n {2}if \(locked\) return Promise\.resolve\(state\);/);
    expect(client).toMatch(/async function doSync\(\): Promise<void> \{\n {2}if \(locked\) return;/);
    expect(client).toContain('if (locked) return null;');
    expect(client).toContain('if (locked || !worker ||');
  });

  test('a sync pull flags the profile before writing its rows, and stops if the session ended meanwhile', () => {
    const flag = client.indexOf('recordProfileAuth(localStore(), profile, authEnabled);');
    const apply = client.indexOf('await rpcSyncTarget()(payload);');
    expect(flag).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(flag);
    // Asked before and after the pull, so a profile switch mid-pull cannot flag the new profile "off".
    const after = client.indexOf('const authEnabled = authBefore || (await authEnabledNow());');
    expect(client.indexOf('const authBefore = await authEnabledNow();')).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(client.indexOf('await collectSyncPayload(syncFetcher'));
    expect(flag).toBeGreaterThan(after);
    expect(client).toContain('if (!current()) return;\n    await rpcSyncTarget()(payload);');
    expect(client).toContain("if (!current()) return;\n      const opened = (await rpc('setProfile'");
  });

  test('a lock bumps the session before its wipe goes to the worker, which closes the pool and deletes it', () => {
    expect(client).toMatch(/export function lockMirror\(\): Promise<void> \{\n {2}locked = true;\n {2}sessionEpoch\+\+;/);
    expect(client).toContain("await rpc('wipe', { profiles }");
    // The list includes every pool on the OPFS root, read before the wipe goes out.
    const listing = client.indexOf('profilesToWipe(local, state.profile, await listMirrorPoolProfiles(root))');
    expect(listing).toBeGreaterThan(-1);
    expect(listing).toBeLessThan(client.indexOf("await rpc('wipe', { profiles }"));
    expect(client).toContain('clearLedgerStorage(local, sessionStore());');
    expect(worker).toContain("case 'wipe': {");
    expect(worker).toContain('return removeMirrorPools(root,');
    // After terminating its own worker, the tab retries the pools that worker was still letting go of.
    const terminate = client.indexOf('w.terminate();');
    const fallback = client.indexOf('removeMirrorPools(root, failed, { retryDelaysMs: w ? POOL_RELEASE_RETRY_MS : [] })');
    expect(terminate).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(terminate);
  });

  test("the worker's wipe can delete the pool: closing the handle releases the VFS access handles", () => {
    // AccessHandlePoolVFS keeps a sync access handle on every pool file until vfs.close(); closing the SQLite
    // connection only flushes, and removeEntry fails with NoModificationAllowedError while any handle is open.
    const close = adapter.slice(adapter.lastIndexOf('async close(): Promise<void> {'));
    expect(close).toMatch(/try \{\n\s+await binding\.close\(\);\n\s+\} finally \{[\s\S]*?await vfs\.close\(\);/);
    // A pool that fails to open part-way releases its handles too.
    expect(adapter).toMatch(/\} catch \(err\) \{\n\s+if \(opened !== undefined\) await sqlite3\.close\(opened\)[^\n]*\n\s+await vfs\.close\(\)/);
    // The worker closes the handle (not just the binding) before removing the directory.
    const wipe = worker.slice(worker.indexOf("case 'wipe': {"));
    expect(wipe.indexOf('await handle.close();')).toBeGreaterThan(-1);
    expect(wipe.indexOf('await handle.close();')).toBeLessThan(wipe.indexOf('removeMirrorPools(root,'));
  });

  test('the gate wipes before a login screen, unlocks before the app and suspends behind any other screen', () => {
    const wipe = gate.indexOf('if (wipe) await lockMirror();');
    // Awaited: an unlock waits out a wipe still in flight (mirror-client-wipe-race.test.ts) before the app mounts.
    const unlock = gate.indexOf("if (next.kind === 'app') await unlockMirror();");
    const suspend = gate.indexOf('else if (!wipe) suspendMirror();');
    const show = gate.indexOf('setView(next);');
    expect(wipe).toBeGreaterThan(-1);
    // Not an else: a user switch wipes and then unlocks for the new login.
    expect(unlock).toBeGreaterThan(wipe);
    expect(suspend).toBeGreaterThan(unlock);
    expect(show).toBeGreaterThan(suspend);
    expect(gate).toContain('offlineLoginRequired(storage, readAuthToken() !== null)');
    // The owner the check is settled against is remembered by the gate (and across reloads), not read off the last view.
    expect(gate).toContain('const mirrorOwnerRef = useRef(readMirrorOwner(localStore()));');
    expect(gate).toMatch(/settleAuthCheck\(\s*check, viewRef\.current, undefined, offlineLocked, mirrorOwnerRef\.current,\s*\)/);
    const remember = gate.indexOf('mirrorOwnerRef.current = mirrorOwner;');
    expect(remember).toBeGreaterThan(wipe);
    expect(remember).toBeLessThan(unlock);
    expect(gate).toContain('writeMirrorOwner(storage, mirrorOwner);');
  });

  test('suspending stops syncs and reads without a wipe; unlocking reopens', () => {
    const body = client.slice(client.indexOf('export function suspendMirror(): void {'));
    expect(body).toMatch(/^export function suspendMirror\(\): void \{\n {2}gateSeq\+\+;\n {2}if \(locked\) return;\n {2}locked = true;\n {2}sessionEpoch\+\+;\n\}/);
  });

  test('logout clears the token, tells the bridge and wipes the mirror before it reloads', () => {
    const body = settings.slice(settings.indexOf('async function handleLogout()'));
    const clear = body.indexOf('clearAuthToken();');
    const tell = body.indexOf("dispatchAuthSession('ended');");
    const wipe = body.indexOf('await lockMirror();');
    const reload = body.indexOf('window.location.reload();');
    expect(clear).toBeGreaterThan(-1);
    expect(tell).toBeGreaterThan(clear);
    expect(wipe).toBeGreaterThan(tell);
    expect(reload).toBeGreaterThan(wipe);
  });
});
