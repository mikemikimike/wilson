import type { ParsedTransaction } from './chase.js';
import { FREEFORM_TO_PFC } from '../../../categories/pfc-taxonomy.js';
import type { PfcDetailed } from '../../../categories/pfc-taxonomy.js';
import { parseAmount } from './amount.js';

/**
 * Parse a QIF date string into YYYY-MM-DD format.
 *
 * Supported formats:
 *   M/D'YY   -> 20YY-0M-0D
 *   M-D'YY   -> 20YY-0M-0D
 *   M/D/YYYY -> YYYY-0M-0D
 *   M-D-YYYY -> YYYY-0M-0D
 *   MM/DD/YYYY -> YYYY-MM-DD
 *   M/D/YY   -> 20YY below 50, else 19YY (Quicken writes pre-2000 years this way)
 *   " 1/ 5'26" -> Quicken's space-padded digits are ignored
 */
export function parseQifDate(dateStr: string): string {
  // Quicken pads single digits with spaces (" 1/ 5'26").
  const compact = dateStr.replace(/\s+/g, '');

  // Handle apostrophe year format: M/D'YY or M-D'YY
  // Quicken writes 2000-2009 as a single padded digit (" 3/ 1' 8").
  const apostropheMatch = compact.match(/^(\d{1,2})[/\-](\d{1,2})'(\d{1,2})$/);
  if (apostropheMatch) {
    const [, month, day, year] = apostropheMatch;
    return `20${year.padStart(2, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Handle full year format: M/D/YYYY or M-D-YYYY
  const fullMatch = compact.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (fullMatch) {
    const [, month, day, year] = fullMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Two-digit slash year: Quicken uses this for 19YY, other tools for 20YY.
  // Pivot at 50 so both read sensibly.
  const shortMatch = compact.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$/);
  if (shortMatch) {
    const [, month, day, year] = shortMatch;
    const century = Number(year) < 50 ? '20' : '19';
    return `${century}${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return dateStr.trim();
}

/**
 * Try to map a QIF category string (e.g. "Food:Groceries") to a PFC detailed code.
 *
 * Extracts the subcategory after the last colon, then looks it up in FREEFORM_TO_PFC.
 * Also tries the full category string and the part before the colon.
 */
function mapCategoryToPfc(category: string): PfcDetailed | undefined {
  if (!category) return undefined;

  // Try the full string first
  if (category in FREEFORM_TO_PFC) {
    return FREEFORM_TO_PFC[category];
  }

  // Try subcategory (after last colon)
  const colonIdx = category.lastIndexOf(':');
  if (colonIdx !== -1) {
    const subcategory = category.slice(colonIdx + 1).trim();
    if (subcategory in FREEFORM_TO_PFC) {
      return FREEFORM_TO_PFC[subcategory];
    }

    // Try primary (before colon)
    const primary = category.slice(0, colonIdx).trim();
    if (primary in FREEFORM_TO_PFC) {
      return FREEFORM_TO_PFC[primary];
    }
  }

  return undefined;
}

/**
 * The date string external ids were hashed from before Quicken's date quirks
 * were parsed: the ISO date for forms the old parser understood, otherwise the
 * raw trimmed string. Keeps ids stable for files imported earlier.
 */
function legacyDateKey(dateStr: string): string {
  const trimmed = dateStr.trim();
  return /^\d{1,2}[/\-]\d{1,2}('\d{2}|[/\-]\d{4})$/.test(trimmed) ? parseQifDate(trimmed) : trimmed;
}

/** QIF writes transfers as the other account's name in brackets: "[Savings]" or "[Savings]/Class". */
const TRANSFER_CATEGORY = /^\[[^\]]+\]/;

function categoryToPfc(category: string, amount: number): PfcDetailed | undefined {
  if (TRANSFER_CATEGORY.test(category)) {
    return amount < 0 ? 'TRANSFER_OUT_OTHER_TRANSFER_OUT' : 'TRANSFER_IN_OTHER_TRANSFER_IN';
  }
  return mapCategoryToPfc(category);
}

/**
 * Compute a simple hash for generating external IDs when no check number is available.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/** QIF sections whose records are cash-register transactions we import. */
const TRANSACTION_SECTIONS = new Set(['bank', 'cash', 'ccard', 'oth a', 'oth l']);

interface QifRecord {
  date?: string;
  amount?: string;
  payee?: string;
  category?: string;
  memo?: string;
  checkNumber?: string;
  clearedStatus?: string;
  splits: Array<{
    category?: string;
    memo?: string;
    amount?: string;
  }>;
}

/**
 * Parse QIF (Quicken Interchange Format) content into ParsedTransactions.
 *
 * QIF is a line-based plain text format:
 * - Records separated by `^` on its own line
 * - Each line starts with a single-character code followed by the value
 * - File may start with `!Type:Bank`, `!Type:CCard`, `!Type:Cash`, etc.
 *
 * Field codes:
 *   D — Date          T — Amount        P — Payee
 *   L — Category      M — Memo          N — Check number
 *   C — Cleared status
 *   S — Split category   E — Split memo   $ — Split amount
 */
export function parseQif(content: string): ParsedTransaction[] {
  const lines = content.split(/\r\n?|\n/);
  const transactions: ParsedTransaction[] = [];

  // Files with no !Type header are plain bank registers.
  let section = 'bank';

  // An !Account block names the account for the !Type section right after it.
  // Records in the !Option:AutoSwitch … !Clear:AutoSwitch list only catalog
  // accounts, and a !Type section with no !Account block of its own has none.
  let inAccountBlock = false;
  let inAutoSwitchList = false;
  let pendingAccount: string | undefined;
  let accountName: string | undefined;

  // Identical rows are legitimate (two same-day coffees). Suffix repeats so the
  // in-batch dedup in csv-import.ts doesn't drop them; the first occurrence
  // keeps its legacy id so previously imported files still dedup.
  const idCounts = new Map<string, number>();
  function uniqueId(base: string): string {
    const n = idCounts.get(base) ?? 0;
    idCounts.set(base, n + 1);
    return n === 0 ? base : `${base}~${n}`;
  }

  let current: QifRecord | null = null;
  let currentSplit: { category?: string; memo?: string; amount?: string } | null = null;

  function flushSplit() {
    if (currentSplit && current) {
      current.splits.push(currentSplit);
      currentSplit = null;
    }
  }

  function flushRecord() {
    flushSplit();
    const record = current;
    current = null;
    if (!record) return;
    if (inAccountBlock) {
      // Inside an !Account block, N is the account name.
      const name = record.checkNumber?.trim();
      if (name && !inAutoSwitchList) pendingAccount = name;
      return;
    }
    if (!record.date || !TRANSACTION_SECTIONS.has(section)) return;

    const date = parseQifDate(record.date);
    const payee = record.payee?.trim();
    const memo = record.memo?.trim();
    const description = payee ?? memo ?? 'Unknown';
    const category = record.category?.trim() ?? '';
    const checkNumber = record.checkNumber?.trim();
    const idDate = legacyDateKey(record.date);
    // Only real check numbers identify a transaction; N also holds words like
    // EFT or ATM that repeat on every such row. Check numbers repeat across
    // accounts, so scope them when the file names the account.
    const isCheck = !!checkNumber && /^\d+$/.test(checkNumber);
    const checkId = !isCheck
      ? undefined
      : accountName
        ? `qif-chk-${simpleHash(`${accountName}|${checkNumber}`)}`
        : checkNumber;

    if (record.splits.length > 0) {
      // Split transaction: create one ParsedTransaction per split
      for (const split of record.splits) {
        const splitCategory = split.category?.trim() ?? category;
        const splitAmount = split.amount ? parseAmount(split.amount) : 0;
        const pfcCode = categoryToPfc(splitCategory, splitAmount);
        const splitMemo = split.memo?.trim();

        transactions.push({
          date,
          description,
          amount: splitAmount,
          bank: 'qif',
          merchant_name: payee,
          category: splitCategory || undefined,
          category_detailed: pfcCode,
          check_number: checkNumber,
          account_name: accountName,
          external_id: uniqueId(checkId ?? `qif-${simpleHash(`${idDate}|${description}|${splitAmount}|${splitMemo ?? ''}`)}`),
        });
      }
    } else {
      // Regular (non-split) transaction
      const amount = record.amount ? parseAmount(record.amount) : 0;
      const pfcCode = categoryToPfc(category, amount);

      transactions.push({
        date,
        description,
        amount,
        bank: 'qif',
        merchant_name: payee,
        category: category || undefined,
        category_detailed: pfcCode,
        check_number: checkNumber,
        account_name: accountName,
        external_id: uniqueId(checkId ?? `qif-${simpleHash(`${idDate}|${description}|${amount}`)}`),
      });
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('!')) {
      flushRecord();
      const header = trimmed.toLowerCase();
      if (header === '!account') {
        inAccountBlock = true;
      } else if (header === '!option:autoswitch') {
        inAutoSwitchList = true;
      } else if (header === '!clear:autoswitch') {
        inAutoSwitchList = false;
      } else if (header.startsWith('!type:')) {
        inAccountBlock = false;
        section = header.slice('!type:'.length).trim();
        accountName = pendingAccount;
        pendingAccount = undefined;
      }
      continue;
    }

    // Record separator
    if (trimmed === '^') {
      flushRecord();
      continue;
    }

    // Start a new record if needed
    if (!current) {
      current = { splits: [] };
    }

    const code = trimmed[0];
    const value = trimmed.slice(1);

    switch (code) {
      case 'D':
        current.date = value;
        break;
      case 'T':
        current.amount = value;
        break;
      case 'P':
        current.payee = value;
        break;
      case 'L':
        current.category = value;
        break;
      case 'M':
        current.memo = value;
        break;
      case 'N':
        current.checkNumber = value;
        break;
      case 'C':
        current.clearedStatus = value;
        break;
      case 'S':
        // New split entry — flush any previous split
        flushSplit();
        currentSplit = { category: value };
        break;
      case 'E':
        if (currentSplit) currentSplit.memo = value;
        break;
      case '$':
        if (currentSplit) currentSplit.amount = value;
        break;
    }
  }

  // Flush any trailing record (no final ^)
  flushRecord();

  return transactions;
}

/**
 * Detect whether content looks like QIF format.
 *
 * Returns true if content starts with `!Type:` or has the QIF record pattern
 * (lines starting with D, T, P codes followed by `^`).
 */
export function isQifContent(content: string): boolean {
  const trimmed = content.trimStart();

  // Check for QIF type header
  if (trimmed.startsWith('!Type:')) {
    return true;
  }

  // Check for QIF record pattern: look for D/T/P lines and ^ separator
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let hasDate = false;
  let hasAmount = false;
  let hasSeparator = false;

  for (const line of lines) {
    if (line.match(/^D\d/)) hasDate = true;
    if (line.match(/^T-?\d/)) hasAmount = true;
    if (line === '^') hasSeparator = true;
    if (hasDate && hasAmount && hasSeparator) return true;
  }

  return false;
}
