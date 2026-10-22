/**
 * The legacy dashboard's inline transaction editor must surface a refused edit.
 * PATCH /api/transactions/:id now answers 400 for bad input (free-text category,
 * long description, control characters, null amount) and 404 for a missing row;
 * saveTxn/deleteTxn used to ignore res.ok, reload the table and silently show the
 * old value. They now alert the server's `error` and leave the editor alone.
 */
import { describe, expect, test } from 'bun:test';
import { getDashboardHtml } from '../dashboard/html.js';

interface Harness {
  saveTxn(id: number, u: unknown): Promise<void>;
  deleteTxn(id: number): Promise<void>;
  alerts: string[];
  reloads: number;
  calls: Array<{ url: string; opts: { method?: string; body?: string } }>;
}

function harness(response: { status: number; body: unknown } | Error): Harness {
  const html = getDashboardHtml(0);
  const start = html.indexOf("async function txnWriteError(");
  const end = html.indexOf('// ── Export', start);
  if (start < 0 || end < 0) throw new Error('txnWriteError/saveTxn/deleteTxn not found in dashboard html');
  const h = { alerts: [] as string[], reloads: 0, calls: [] as Harness['calls'] } as Harness;
  const authFetch = async (url: string, opts: { method?: string; body?: string }) => {
    h.calls.push({ url, opts });
    if (response instanceof Error) throw response;
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), { status: response.status });
  };
  const fns = new Function(
    'authFetch', 'alert', 'confirm', 'loadTransactions', 'loadOverview', 'BASE',
    `${html.slice(start, end)}; return { saveTxn: saveTxn, deleteTxn: deleteTxn };`,
  )(authFetch, (m: string) => { h.alerts.push(m); }, () => true, () => { h.reloads++; }, () => {}, '');
  h.saveTxn = fns.saveTxn;
  h.deleteTxn = fns.deleteTxn;
  return h;
}

describe('legacy dashboard transaction edit errors', () => {
  test('a 400 on save alerts the server error and does not reload the table', async () => {
    const h = harness({ status: 400, body: { success: false, error: 'unknown category "Coffee stuff"' } });
    await h.saveTxn(7, { category: 'Coffee stuff' });
    expect(h.calls[0].opts.method).toBe('PATCH');
    expect(h.alerts).toEqual(['Error: unknown category "Coffee stuff"']);
    expect(h.reloads).toBe(0);
  });

  test('a 404 on save or delete alerts the server error', async () => {
    const save = harness({ status: 404, body: { success: false, error: 'transaction #7 not found' } });
    await save.saveTxn(7, { notes: 'x' });
    expect(save.alerts).toEqual(['Error: transaction #7 not found']);
    const del = harness({ status: 404, body: { success: false, error: 'transaction #7 not found' } });
    await del.deleteTxn(7);
    expect(del.calls[0].opts.method).toBe('DELETE');
    expect(del.alerts).toEqual(['Error: transaction #7 not found']);
    expect(del.reloads).toBe(0);
  });

  test('a non-JSON error body still alerts with the HTTP status', async () => {
    const h = harness({ status: 500, body: 'Internal Server Error' });
    await h.saveTxn(7, { notes: 'x' });
    expect(h.alerts).toEqual(['Error: HTTP 500']);
  });

  test('a successful save reloads without an alert', async () => {
    const h = harness({ status: 200, body: { success: true, id: 7 } });
    await h.saveTxn(7, { amount: -13 });
    expect(h.alerts).toEqual([]);
    expect(h.reloads).toBe(1);
  });

  test('a network failure still alerts', async () => {
    const h = harness(new Error('offline'));
    await h.deleteTxn(7);
    expect(h.alerts).toEqual(['Error: offline']);
  });
});
