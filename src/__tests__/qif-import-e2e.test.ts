import { describe, expect, test, beforeEach } from 'bun:test';
import { join } from 'path';
import type { Database } from '../db/compat-sqlite.js';
import { initImportTool, csvImportTool } from '../tools/import/csv-import.js';
import { getTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { createTestDb } from './helpers.js';

const FIXTURE = join(import.meta.dir, 'fixtures', 'quicken-multi-account.qif');

describe('Quicken multi-account QIF through csv_import', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
    insertAccount(db, { name: 'Fixture Checking', account_type: 'asset', account_subtype: 'checking' });
  });

  async function runImport() {
    return JSON.parse((await csvImportTool.func({ filePath: FIXTURE })) as string).data;
  }

  test('imports every cash transaction, including both identical coffees and both splits', async () => {
    const data = await runImport();
    expect(data.success).toBe(true);
    expect(data.bankDetected).toBe('qif');
    // 2 coffees + 2 rent splits + 1 transfer out + 1 transfer in + 1 bookstore
    expect(data.transactionsImported).toBe(7);
    expect(data.transactionsSkipped).toBe(0);
  });

  test('rows carry their account and auto-link to tracked accounts', async () => {
    await runImport();
    const txns = getTransactions(db);
    const checking = txns.filter((t) => t.account_name === 'Fixture Checking');
    const card = txns.filter((t) => t.account_name === 'Fixture Card');
    expect(checking).toHaveLength(5);
    expect(card).toHaveLength(2);
    expect(checking.every((t) => t.account_id !== null)).toBe(true);
    expect(card.every((t) => t.account_id === null)).toBe(true);
  });

  test('transfers are classified on both sides', async () => {
    await runImport();
    const transfers = getTransactions(db).filter((t) => t.category_detailed?.startsWith('TRANSFER_'));
    expect(transfers.map((t) => t.category_detailed).sort()).toEqual([
      'TRANSFER_IN_OTHER_TRANSFER_IN',
      'TRANSFER_OUT_OTHER_TRANSFER_OUT',
    ]);
  });

  test('no category-list record leaks in as a transaction', async () => {
    await runImport();
    expect(getTransactions(db).every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
  });

  test('re-importing is idempotent', async () => {
    await runImport();
    await runImport();
    expect(getTransactions(db)).toHaveLength(7);
  });
});
