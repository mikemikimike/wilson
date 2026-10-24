// ── Shared /api/transactions query-param parsing ─────────────────────────────
//
// The server endpoint (apiTransactions in src/dashboard/api.ts) and the offline
// mirror's `serveApiPath` parse the exact same query params through this one
// function, so both sides run identical SQL for identical URLs.
//
// Params: start|startDate, end|endDate (aliases — the overview endpoints use
// startDate/endDate, the transactions tab start/end; `start`/`end` win when
// both are present), category, merchant (fuzzy LIKE on description),
// merchantExact (exact merchant label), accountId, entityId, spendOnly
// (1|true), limit (default 100), offset (default 0). Paging runs in SQL.
// Edge behavior kept from the JS-slice era: `limit=` (empty) parses to NaN,
// which yields zero rows. One strict rule on top (checkTransactionListParams):
// a numeric param past 2^53 is a 400, never a SQLite 500 (#197).
//
// Import-safe for the dashboard UI bundle: imports only the spending-params
// module (itself UI-safe) and a type from the transaction-where module.

import type { TransactionFilters } from '../db/transaction-where.js';
import { outOfRangeInt, type BadRequest } from './spending-params.js';

export interface TransactionListParams {
  filters: TransactionFilters;
  limit: number;
  offset: number;
}

/**
 * The BadRequest for a numeric param past 2^53 (`limit is out of range`), or null. The server answers it as a
 * 400 `{ error }` and the mirror returns it as is, which the fetch seam raises as the same "API 400" error.
 */
export function checkTransactionListParams(params: URLSearchParams): BadRequest | null {
  return outOfRangeInt(params, 'limit', 'offset', 'accountId', 'entityId');
}

export function parseTransactionListParams(params: URLSearchParams): TransactionListParams {
  const filters: TransactionFilters = {};
  const start = params.get('start') || params.get('startDate');
  const end = params.get('end') || params.get('endDate');
  const category = params.get('category');
  const merchant = params.get('merchant');
  const merchantExact = params.get('merchantExact');
  const spendOnly = params.get('spendOnly');
  const accountIdVal = params.get('accountId');
  const entityIdVal = params.get('entityId');
  const accountId = accountIdVal ? parseInt(accountIdVal, 10) : undefined;
  const entityId = entityIdVal ? parseInt(entityIdVal, 10) : undefined;
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (merchant) filters.merchant = merchant;
  if (merchantExact) filters.merchantExact = merchantExact;
  if (spendOnly === '1' || spendOnly === 'true') filters.spendOnly = true;
  if (accountId !== undefined) filters.accountId = accountId;
  if (entityId !== undefined) filters.entityId = entityId;
  const limit = parseInt(params.get('limit') ?? '100', 10);
  const offsetRaw = parseInt(params.get('offset') ?? '0', 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  return { filters, limit, offset };
}
