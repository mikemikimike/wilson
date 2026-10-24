import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_NAME_MAX,
  ACCOUNT_SUBTYPE_GROUPS,
  EMPTY_NEW_ACCOUNT,
  addAccountEntry,
  newAccountBody,
  newAccountError,
} from '../dashboard/ui/src/lib/accountCreate';
import { ACCOUNT_NAME_MAX as SERVER_NAME_MAX } from '../dashboard/api.js';
import { ACCOUNT_SUBTYPES } from '../tools/net-worth/account-types.js';

// #199: the dashboard's "Add account" / importer "New account…" form logic.

describe('newAccountError', () => {
  test('name is required and limited like the server', () => {
    expect(ACCOUNT_NAME_MAX).toBe(SERVER_NAME_MAX);
    expect(newAccountError(EMPTY_NEW_ACCOUNT)).toBe('Name is required.');
    expect(newAccountError({ ...EMPTY_NEW_ACCOUNT, name: '   ' })).toBe('Name is required.');
    expect(newAccountError({ ...EMPTY_NEW_ACCOUNT, name: 'x'.repeat(ACCOUNT_NAME_MAX + 1) })).toMatch(/at most 80/);
    expect(newAccountError({ ...EMPTY_NEW_ACCOUNT, name: 'Checking' })).toBeNull();
  });
  test('last 4 is optional but must be 4 digits', () => {
    expect(newAccountError({ ...EMPTY_NEW_ACCOUNT, name: 'Checking', last4: '12' })).toMatch(/4 digits/);
    expect(newAccountError({ ...EMPTY_NEW_ACCOUNT, name: 'Checking', last4: '1234' })).toBeNull();
  });
});

describe('newAccountBody', () => {
  test('trims and leaves blank optionals out', () => {
    expect(newAccountBody({ name: ' Joint ', subtype: 'savings', institution: ' ', last4: '' })).toEqual({ name: 'Joint', accountSubtype: 'savings' });
    expect(newAccountBody({ name: 'Card', subtype: 'credit_card', institution: ' Bank ', last4: '9876' })).toEqual({
      name: 'Card',
      accountSubtype: 'credit_card',
      institution: 'Bank',
      accountNumberLast4: '9876',
    });
  });
});

describe('subtype options', () => {
  test('cover exactly the server-allowed subtypes', () => {
    const values = ACCOUNT_SUBTYPE_GROUPS.flatMap((g) => g.options.map((o) => o.value));
    expect(values).toEqual([...ACCOUNT_SUBTYPES]);
  });
});

describe('addAccountEntry', () => {
  test('viewer: disabled with the admin-only tooltip', () => {
    const e = addAccountEntry({ authEnabled: true, user: { role: 'viewer' } });
    expect(e.disabled).toBe(true);
    expect(e.label).toBe('Add account (admin only)');
    expect(e.title).toMatch(/admin-only/);
  });
  test('admin, auth off, and still loading: enabled', () => {
    expect(addAccountEntry({ authEnabled: true, user: { role: 'admin' } })).toEqual({ disabled: false, label: 'Add account' });
    expect(addAccountEntry({ authEnabled: false, user: null }).disabled).toBe(false);
    expect(addAccountEntry(null).disabled).toBe(false);
  });
});
