// Structural report on a QIF file: shape only, never payees, amounts, or account names.
// Usage: bun scripts/quicken/qif-shape.ts <file.qif>
import { readFileSync } from 'fs';
import { parseQif } from '../../src/tools/import/parsers/qif.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun scripts/quicken/qif-shape.ts <file.qif>');
  process.exit(1);
}

// Only known header shapes are printed; anything else starting with "!" is
// counted, never echoed, since it could carry transaction content.
const HEADER =
  /^!(Type:(Bank|Cash|CCard|Invst|Oth A|Oth L|Invoice|Cat|Class|Memorized|Prices|Security|Budget|Payee|Template)|Account|Option:AutoSwitch|Clear:AutoSwitch)$/i;

const content = readFileSync(path, 'utf8');
const sectionHeaders = new Map<string, number>();
const recordsBySection = new Map<string, number>();
let otherBangLines = 0;
let section = '(no header)';

for (const line of content.split(/\r\n?|\n/)) {
  const t = line.trim();
  if (t.startsWith('!')) {
    if (!HEADER.test(t)) {
      otherBangLines++;
      continue;
    }
    sectionHeaders.set(t, (sectionHeaders.get(t) ?? 0) + 1);
    if (/^!type:/i.test(t)) section = t;
    else if (/^!account$/i.test(t)) section = '!Account';
    continue;
  }
  if (t === '^') recordsBySection.set(section, (recordsBySection.get(section) ?? 0) + 1);
}

const txns = parseQif(content);
const dates = txns.map((t) => t.date).sort();
console.log(JSON.stringify({
  crOnlyLineEndings: content.includes('\r') && !content.includes('\n'),
  sectionHeaders: Object.fromEntries(sectionHeaders),
  otherBangLines,
  // Records in non-cash sections (e.g. !Type:Invst) are not imported; compare with `transactions`.
  recordsBySection: Object.fromEntries(recordsBySection),
  transactions: txns.length,
  distinctAccounts: new Set(txns.map((t) => t.account_name).filter(Boolean)).size,
  rowsWithoutAccount: txns.filter((t) => !t.account_name).length,
  transfers: txns.filter((t) => t.category_detailed?.startsWith('TRANSFER_')).length,
  suffixedIds: txns.filter((t) => t.external_id?.includes('~')).length,
  unparsedDates: txns.filter((t) => !/^\d{4}-\d{2}-\d{2}$/.test(t.date)).length,
  dateRange: [dates[0], dates[dates.length - 1]],
}, null, 2));
