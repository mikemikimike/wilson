// @invariant NN-09
import { describe, expect, test } from 'bun:test';
import {
  importToastModel,
  showImportToast,
  dismissImportToast,
  getImportToast,
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
