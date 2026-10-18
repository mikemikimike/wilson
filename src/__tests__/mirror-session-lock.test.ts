import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIRROR_PROFILE,
  LEDGER_LOCAL_KEYS,
  LEDGER_SESSION_PREFIXES,
  MIRROR_AUTH_PROFILES_KEY,
  MIRROR_PROFILE_KEY,
  clearLedgerStorage,
  noteAuthEnabled,
  offlineLoginRequired,
  poolDirectoryName,
  profilesToWipe,
  readAuthProfiles,
  readStoredMirrorProfile,
  recordProfileAuth,
  removeMirrorPools,
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
    expect(storage.data.has(MIRROR_AUTH_PROFILES_KEY)).toBe(false);
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

describe('offlineLoginRequired', () => {
  const flagged = () => memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '["household"]' });

  test('the stored profile has auth on and there is no login: the mirror stays shut', () => {
    expect(offlineLoginRequired(flagged(), false)).toBe(true);
  });

  test('a stored login (the server cannot be asked offline) opens it', () => {
    expect(offlineLoginRequired(flagged(), true)).toBe(false);
  });

  test("profiles without auth keep today's offline behaviour", () => {
    expect(offlineLoginRequired(memoryStorage({ [MIRROR_PROFILE_KEY]: 'household' }), false)).toBe(false);
    expect(offlineLoginRequired(memoryStorage({ [MIRROR_PROFILE_KEY]: 'other', [MIRROR_AUTH_PROFILES_KEY]: '["household"]' }), false)).toBe(false);
    expect(offlineLoginRequired(memoryStorage(), false)).toBe(false);
  });
});

describe('what a wipe removes', () => {
  test('the open pool, the stored one and every auth profile, once each', () => {
    const storage = memoryStorage({ [MIRROR_PROFILE_KEY]: 'household', [MIRROR_AUTH_PROFILES_KEY]: '["household","business"]' });
    expect(profilesToWipe(storage, 'demo')).toEqual(['demo', 'household', 'business']);
    expect(profilesToWipe(memoryStorage(), null)).toEqual([DEFAULT_MIRROR_PROFILE]);
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

  test('the mirror starts locked: nothing opens, syncs or serves before the gate unlocks it', () => {
    expect(client).toContain('let locked = true;');
    expect(client).toMatch(/export function initMirror\(\): Promise<MirrorState> \{\n {2}if \(locked\) return Promise\.resolve\(state\);/);
    expect(client).toMatch(/async function doSync\(\): Promise<void> \{\n {2}if \(locked\) return;/);
    expect(client).toContain('if (locked) return null;');
    expect(client).toContain('if (locked || !worker ||');
  });

  test('a sync pull flags the profile before writing its rows, and stops if the session ended meanwhile', () => {
    const flag = client.indexOf('recordProfileAuth(localStore(), profile, authEnabled);');
    const apply = client.indexOf('await rpcSyncTarget()(payload);');
    expect(flag).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(flag);
    expect(client).toContain('if (!current()) return;\n    await rpcSyncTarget()(payload);');
    expect(client).toContain("if (!current()) return;\n      const opened = (await rpc('setProfile'");
  });

  test('a lock bumps the session before its wipe goes to the worker, which closes the pool and deletes it', () => {
    expect(client).toMatch(/export function lockMirror\(\): Promise<void> \{\n {2}locked = true;\n {2}sessionEpoch\+\+;/);
    expect(client).toContain("await rpc('wipe', { profiles }");
    expect(client).toContain('clearLedgerStorage(local, sessionStore());');
    expect(worker).toContain("case 'wipe': {");
    expect(worker).toContain('return removeMirrorPools(root,');
  });

  test('the gate wipes before a login screen and unlocks before the app', () => {
    const wipe = gate.indexOf('if (wipe) await lockMirror();');
    const unlock = gate.indexOf("else if (next.kind === 'app') unlockMirror();");
    const show = gate.indexOf('setView(next);');
    expect(wipe).toBeGreaterThan(-1);
    expect(unlock).toBeGreaterThan(wipe);
    expect(show).toBeGreaterThan(unlock);
    expect(gate).toContain('offlineLoginRequired(storage, readAuthToken() !== null)');
    expect(gate).toContain("if (check.kind === 'status' && check.status.authEnabled) noteAuthEnabled(storage);");
  });

  test('logout clears the token and wipes the mirror before it reloads', () => {
    const body = settings.slice(settings.indexOf('async function handleLogout()'));
    const clear = body.indexOf('clearAuthToken();');
    const wipe = body.indexOf('await lockMirror();');
    const reload = body.indexOf('window.location.reload();');
    expect(clear).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(clear);
    expect(reload).toBeGreaterThan(wipe);
  });
});
