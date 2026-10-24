import { useState } from 'react';
import { api } from '@/api';
import { apiErrorMessage } from '@/lib/firstAdmin';
import {
  ACCOUNT_NAME_MAX,
  ACCOUNT_SUBTYPE_GROUPS,
  EMPTY_NEW_ACCOUNT,
  newAccountBody,
  newAccountError,
  type AccountSubtype,
  type NewAccountInput,
} from '@/lib/accountCreate';
import type { Account } from '@/types';

interface NewAccountFormProps {
  /** Called with the row the server created (POST /api/accounts). */
  onCreated: (account: Account) => void;
  onCancel: () => void;
  /** Tighter layout for the importer's inline use. */
  compact?: boolean;
}

const inputClass =
  'w-full min-w-0 bg-surface-raised border border-border rounded-md px-2 py-1.5 text-sm text-text focus:outline-none focus:border-green';

/** Name + subtype (+ optional institution and last 4) for a new account (#199). Used by the Accounts tab and the importer. */
export function NewAccountForm({ onCreated, onCancel, compact }: NewAccountFormProps) {
  const [input, setInput] = useState<NewAccountInput>(EMPTY_NEW_ACCOUNT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (patch: Partial<NewAccountInput>) => setInput((prev) => ({ ...prev, ...patch }));

  async function submit() {
    if (saving) return;
    const problem = newAccountError(input);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await api<{ success: boolean; account: Account }>('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(newAccountBody(input)),
      });
      onCreated(res.account);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add the account.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-label="New account"
      className={compact ? 'space-y-2' : 'space-y-3'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block text-sm">
        <span className="text-text-muted">Name</span>
        <input
          type="text"
          value={input.name}
          onChange={(e) => set({ name: e.target.value })}
          maxLength={ACCOUNT_NAME_MAX}
          required
          autoFocus
          placeholder="e.g. Joint checking"
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm">
        <span className="text-text-muted">Type</span>
        <select
          value={input.subtype}
          onChange={(e) => set({ subtype: e.target.value as AccountSubtype })}
          className={`${inputClass} mt-1`}
        >
          {ACCOUNT_SUBTYPE_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-2">
        <label className="block text-sm min-w-0">
          <span className="text-text-muted">
            Institution <span className="text-xs">(optional)</span>
          </span>
          <input
            type="text"
            value={input.institution}
            onChange={(e) => set({ institution: e.target.value })}
            maxLength={ACCOUNT_NAME_MAX}
            className={`${inputClass} mt-1`}
          />
        </label>
        <label className="block text-sm min-w-0">
          <span className="text-text-muted">
            Last 4 <span className="text-xs">(optional)</span>
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={input.last4}
            onChange={(e) => set({ last4: e.target.value })}
            maxLength={4}
            className={`${inputClass} mt-1 font-mono`}
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="border border-red/40 bg-red/10 rounded-md px-3 py-2 text-sm text-red break-words">
          {error}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="bg-transparent text-text-muted border border-border px-3 py-1.5 rounded text-sm cursor-pointer hover:text-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-sm font-medium px-3 py-1.5 rounded transition-colors cursor-pointer disabled:cursor-not-allowed border-none"
        >
          {saving ? 'Adding…' : 'Add account'}
        </button>
      </div>
    </form>
  );
}
