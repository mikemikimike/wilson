// @invariant NN-09
import { describe, expect, test } from 'bun:test';
import {
  importToastModel,
  showImportToast,
  dismissImportToast,
  getImportToast,
  importBannerModel,
} from '../dashboard/ui/src/lib/importToast';

describe('importToastModel', () => {
  test('reports the imported count only', () => {
    expect(importToastModel({ transactionsImported: 12, transactionsSkipped: 0 })).toEqual({ message: '12 transactions imported', hasNew: true });
  });
  test('singular', () => {
    expect(importToastModel({ transactionsImported: 1, transactionsSkipped: 0 }).message).toBe('1 transaction imported');
  });
  test('mentions skipped duplicates using the API counts', () => {
    expect(importToastModel({ transactionsImported: 8, transactionsSkipped: 3 }).message).toBe('8 transactions imported (3 duplicates skipped)');
    expect(importToastModel({ transactionsImported: 2, transactionsSkipped: 1 }).message).toBe('2 transactions imported (1 duplicate skipped)');
  });
  test('all duplicates: no View, no invented import count', () => {
    expect(importToastModel({ transactionsImported: 0, transactionsSkipped: 5 })).toEqual({
      message: 'No new transactions imported (5 duplicates skipped)',
      hasNew: false,
    });
    expect(importToastModel({ transactionsImported: 0, transactionsSkipped: 0 }).message).toBe('No new transactions imported');
  });
  test('thousands are grouped', () => {
    expect(importToastModel({ transactionsImported: 1234, transactionsSkipped: 0 }).message).toBe('1,234 transactions imported');
  });
});

describe('import toast store', () => {
  test('show then dismiss', () => {
    showImportToast({ transactionsImported: 4, transactionsSkipped: 0 });
    expect(getImportToast()?.model.message).toBe('4 transactions imported');
    dismissImportToast();
    expect(getImportToast()).toBeNull();
  });
});

// #201: a re-import that added nothing is not a success, and the copy comes from the API's own answer.
describe('importBannerModel', () => {
  test('rows added: success tone with the server message', () => {
    expect(importBannerModel({ status: 'imported', transactionsImported: 3, transactionsSkipped: 1, message: 'Imported 3 transactions from a.csv (2026-01-01 to 2026-01-31). 1 duplicates skipped.' })).toEqual({
      tone: 'success',
      message: 'Imported 3 transactions from a.csv (2026-01-01 to 2026-01-31). 1 duplicates skipped.',
    });
  });
  test('same file again: neutral, says it was already imported and when', () => {
    expect(importBannerModel({
      status: 'skipped',
      transactionsImported: 0,
      transactionsSkipped: 3,
      previouslyImported: { importedAt: '2026-10-24 09:15:00', transactionCount: 3 },
      message: 'This file was already imported on 2026-10-24 09:15:00 (3 transactions).',
    })).toEqual({ tone: 'neutral', message: 'No new transactions — this file was already imported on 2026-10-24.' });
  });
  test('every row already present: neutral, with the real count', () => {
    expect(importBannerModel({ status: 'skipped', transactionsImported: 0, transactionsSkipped: 5, message: 'All 5 transactions already exist (skipped as duplicates).' })).toEqual({
      tone: 'neutral',
      message: 'No new transactions — all 5 transactions in this file were already imported.',
    });
    expect(importBannerModel({ status: 'skipped', transactionsImported: 0, transactionsSkipped: 1, message: '' }).message).toBe(
      'No new transactions — the 1 transaction in this file was already imported.',
    );
  });
  test('nothing imported and no counts: neutral, claims nothing else', () => {
    expect(importBannerModel({ status: 'skipped', transactionsImported: 0, transactionsSkipped: 0, message: '' })).toEqual({
      tone: 'neutral',
      message: 'No new transactions imported.',
    });
  });
});
