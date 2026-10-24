/**
 * Adding an account from the dashboard (#199): the Accounts tab's "Add account" and the importer's "New account…"
 * option (pure, unit-tested). The server is the gate (canWrite + validation on POST /api/accounts, NN-04); these only
 * decide what a person is offered and catch an empty name before the request.
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */
import {
  ASSET_SUBTYPES,
  LIABILITY_SUBTYPES,
  SUBTYPE_LABELS,
  type AccountSubtype,
} from '../../../../tools/net-worth/account-types.js';
import { isKnownReadOnly, type WriteAuthStatus } from './transactionEditing.js';

export type { AccountSubtype };

/** Mirrors ACCOUNT_NAME_MAX in src/dashboard/api.ts (not imported — that file pulls bun:sqlite into the ui program). */
export const ACCOUNT_NAME_MAX = 80;

/** The import picker's "New account…" option value; never a real id (ids are positive integers). */
export const NEW_ACCOUNT_OPTION = '__new__';

export interface SubtypeGroup {
  label: string;
  options: { value: AccountSubtype; label: string }[];
}

/** The subtype <select>'s option groups, in the server's allowed set and order. */
export const ACCOUNT_SUBTYPE_GROUPS: SubtypeGroup[] = [
  { label: 'Assets', options: ASSET_SUBTYPES.map((value) => ({ value, label: SUBTYPE_LABELS[value] })) },
  { label: 'Liabilities', options: LIABILITY_SUBTYPES.map((value) => ({ value, label: SUBTYPE_LABELS[value] })) },
];

export interface NewAccountInput {
  name: string;
  subtype: AccountSubtype;
  institution: string;
  last4: string;
}

export const EMPTY_NEW_ACCOUNT: NewAccountInput = { name: '', subtype: 'checking', institution: '', last4: '' };

/** The first thing wrong with the form, or null when it can be sent. The server re-checks all of it. */
export function newAccountError(input: NewAccountInput): string | null {
  const name = input.name.trim();
  if (!name) return 'Name is required.';
  if (name.length > ACCOUNT_NAME_MAX) return `Name must be at most ${ACCOUNT_NAME_MAX} characters.`;
  const last4 = input.last4.trim();
  if (last4 && !/^\d{4}$/.test(last4)) return 'Last 4 digits must be exactly 4 digits.';
  return null;
}

/** The body for POST /api/accounts; blank optional fields are left out. */
export function newAccountBody(input: NewAccountInput): {
  name: string;
  accountSubtype: AccountSubtype;
  institution?: string;
  accountNumberLast4?: string;
} {
  const institution = input.institution.trim();
  const last4 = input.last4.trim();
  return {
    name: input.name.trim(),
    accountSubtype: input.subtype,
    ...(institution ? { institution } : {}),
    ...(last4 ? { accountNumberLast4: last4 } : {}),
  };
}

export const ADD_ACCOUNT_ADMIN_ONLY_TITLE =
  'Adding accounts is admin-only. Ask your household admin to add it, or to give you an admin account.';

export interface AddAccountEntry {
  disabled: boolean;
  label: string;
  /** Tooltip; present only when the entry is disabled. */
  title?: string;
}

/** The "Add account" button: disabled and relabelled only once the status says this person is read-only (cf. importEntry). */
export function addAccountEntry(auth: WriteAuthStatus | null | undefined): AddAccountEntry {
  if (isKnownReadOnly(auth)) return { disabled: true, label: 'Add account (admin only)', title: ADD_ACCOUNT_ADMIN_ONLY_TITLE };
  return { disabled: false, label: 'Add account' };
}
