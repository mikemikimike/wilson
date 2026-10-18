import { describe, expect, test } from 'bun:test';
import { getDashboardHtml } from '../dashboard/html.js';

/**
 * The legacy HTML dashboard stores its session under the same key as the React dashboard and the WebMCP bridge
 * ('wilson_auth_token'), so a login in one is a login in the other. Its old key, 'oa_token', is read once as a
 * fallback and removed.
 */

interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(initial: Record<string, string> = {}): KeyValue & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const throwingStorage: KeyValue = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

describe('legacy dashboard token key', () => {
  // The legacy page ships its script inside a template string; pull out readStoredToken and run it.
  const html = getDashboardHtml(0);
  const start = html.indexOf("var AUTH_KEY = 'wilson_auth_token';");
  const end = html.indexOf('var authToken = readStoredToken();');
  if (start < 0 || end < 0) throw new Error('readStoredToken not found in dashboard html');
  const readStoredToken = (localStorage: KeyValue): string =>
    new Function('localStorage', `${html.slice(start, end)}; return readStoredToken();`)(localStorage);

  test('reads the shared key, migrating oa_token once', () => {
    const legacy = memoryStorage({ oa_token: 'old' });
    expect(readStoredToken(legacy)).toBe('old');
    expect(legacy.data.get('wilson_auth_token')).toBe('old');
    expect(legacy.data.has('oa_token')).toBe(false);

    const both = memoryStorage({ oa_token: 'old', wilson_auth_token: 'new' });
    expect(readStoredToken(both)).toBe('new');
    expect(both.data.has('oa_token')).toBe(false);

    expect(readStoredToken(memoryStorage({ wilson_auth_token: 'new' }))).toBe('new');
    expect(readStoredToken(memoryStorage())).toBe('');
    expect(readStoredToken(throwingStorage)).toBe('');
  });

  test('login, setup and logout write the shared key, never oa_token', () => {
    expect(html).not.toMatch(/localStorage\.(setItem|removeItem)\('oa_token'/);
    expect(html.match(/localStorage\.setItem\(AUTH_KEY, authToken\)/g)?.length).toBe(2);
    expect(html).toContain('localStorage.removeItem(AUTH_KEY)');
  });
});
