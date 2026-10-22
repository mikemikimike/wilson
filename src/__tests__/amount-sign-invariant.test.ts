// @invariant NN-07
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAmount } from '../tools/import/parsers/amount.js';
import { parseAmexCSV } from '../tools/import/parsers/amex.js';
import { parseBofA } from '../tools/import/parsers/bofa.js';
import { parseChaseCSV, type ParsedTransaction } from '../tools/import/parsers/chase.js';
import { parseGenericCSV } from '../tools/import/parsers/generic.js';
import { parseOfx } from '../tools/import/parsers/ofx.js';
import { parseQif } from '../tools/import/parsers/qif.js';

/**
 * NN-07: amounts mean one thing. Negative = expense (a purchase, a debit, a check), positive = income or a
 * credit (a refund, a payment to a card, a deposit), for EVERY importer, whatever sign convention the bank's
 * export uses. Amex exports purchases as positive numbers, so its parser must flip them; Chase and BofA already
 * match ours and must not. Each case below is one purchase plus one credit (FAKE dummy data, shapes reused from the
 * per-parser tests), and the guard at the bottom fails when a new parser file appears without a case here.
 */

interface Case {
  /** Parser file in src/tools/import/parsers/ this case covers. */
  file: string;
  label: string;
  parse: () => ParsedTransaction[];
  purchase: string;
  credit: string;
}

const OFX = (accountBlock: string) => `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
${accountBlock}
</OFX>`;

const OFX_BANK = OFX(`<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>FAKE0001<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260215
<TRNAMT>-85.50
<FITID>FAKE-1
<NAME>FAKE GROCER (dummy)
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260210
<TRNAMT>3500.00
<FITID>FAKE-2
<NAME>FAKE PAYROLL DEPOSIT (dummy)
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>`);

const OFX_CARD = OFX(`<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>USD
<CCACCTFROM><ACCTID>FAKE0002</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260215
<TRNAMT>-45.99
<FITID>FAKE-3
<NAME>FAKE BOOKSHOP (dummy)
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260220
<TRNAMT>12.00
<FITID>FAKE-4
<NAME>FAKE BOOKSHOP REFUND (dummy)
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>`);

const CASES: Case[] = [
  {
    file: 'chase.ts',
    label: 'Chase card CSV (bank sign kept: Sale < 0, Payment > 0)',
    parse: () => parseChaseCSV([
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,FAKE STORE PURCHASE (dummy),Shopping,Sale,-100.00',
      '02/20/2026,02/21/2026,FAKE PAYMENT RECEIVED (dummy),Payment,Payment,500.00',
    ].join('\n')),
    purchase: 'FAKE STORE PURCHASE (dummy)',
    credit: 'FAKE PAYMENT RECEIVED (dummy)',
  },
  {
    file: 'amex.ts',
    label: 'Amex CSV (bank sign flipped: +85.50 purchase -> -85.50, -50 refund -> +50)',
    parse: () => parseAmexCSV([
      'Date,Description,Amount',
      '02/15/2026,FAKE PURCHASE (dummy),85.50',
      '02/20/2026,FAKE REFUND (dummy),-50.00',
    ].join('\n')),
    purchase: 'FAKE PURCHASE (dummy)',
    credit: 'FAKE REFUND (dummy)',
  },
  {
    file: 'bofa.ts',
    label: 'BofA checking CSV with metadata header',
    parse: () => parseBofA([
      'Bank of America',
      'Account: ****0000',
      '',
      'Date,Description,Amount,Running Bal.',
      '02/15/2026,"FAKE GROCER (dummy)",-85.50,1234.50',
      '02/10/2026,"FAKE DIRECT DEPOSIT (dummy)",3500.00,4614.50',
    ].join('\n')),
    purchase: 'FAKE GROCER (dummy)',
    credit: 'FAKE DIRECT DEPOSIT (dummy)',
  },
  {
    file: 'bofa.ts',
    label: 'BofA credit card CSV',
    parse: () => parseBofA([
      'Posted Date,Reference Number,Payee,Address,Amount',
      '02/15/2026,0000000001,"FAKE SHOP (dummy)","NOWHERE ZZ",-45.99',
      '02/20/2026,0000000002,"FAKE PAYMENT THANK YOU (dummy)","",150.00',
    ].join('\n')),
    purchase: 'FAKE SHOP (dummy)',
    credit: 'FAKE PAYMENT THANK YOU (dummy)',
  },
  {
    file: 'generic.ts',
    label: 'generic CSV, signed Amount column',
    parse: () => parseGenericCSV([
      'Date,Description,Amount',
      '2026-02-15,FAKE GAS STATION (dummy),-30.00',
      '2026-02-18,FAKE REFUND (dummy),12.00',
    ].join('\n')),
    purchase: 'FAKE GAS STATION (dummy)',
    credit: 'FAKE REFUND (dummy)',
  },
  {
    file: 'generic.ts',
    label: 'generic CSV, separate Withdrawal / Deposit columns (both unsigned)',
    parse: () => parseGenericCSV([
      'Date,Description,Withdrawal,Deposit',
      '2026-02-15,FAKE HARDWARE (dummy),42.00,',
      '2026-02-16,FAKE DEPOSIT (dummy),,900.00',
    ].join('\n')),
    purchase: 'FAKE HARDWARE (dummy)',
    credit: 'FAKE DEPOSIT (dummy)',
  },
  {
    file: 'generic.ts',
    label: 'generic CSV, accounting parentheses for a debit',
    parse: () => parseGenericCSV([
      'Date,Description,Amount',
      '2026-02-15,FAKE PARENS PURCHASE (dummy),"(45.00)"',
      '2026-02-16,FAKE PLAIN CREDIT (dummy),"$1,200.00"',
    ].join('\n')),
    purchase: 'FAKE PARENS PURCHASE (dummy)',
    credit: 'FAKE PLAIN CREDIT (dummy)',
  },
  {
    file: 'ofx.ts',
    label: 'OFX 1.x SGML bank statement',
    parse: () => parseOfx(OFX_BANK),
    purchase: 'FAKE GROCER (dummy)',
    credit: 'FAKE PAYROLL DEPOSIT (dummy)',
  },
  {
    file: 'ofx.ts',
    label: 'OFX 1.x SGML credit card statement',
    parse: () => parseOfx(OFX_CARD),
    purchase: 'FAKE BOOKSHOP (dummy)',
    credit: 'FAKE BOOKSHOP REFUND (dummy)',
  },
  {
    file: 'qif.ts',
    label: 'QIF bank',
    parse: () => parseQif(`!Type:Bank
D03/15/2026
T-85.50
PFAKE GROCER (dummy)
^
D03/10/2026
T3500.00
PFAKE EMPLOYER (dummy)
^`),
    purchase: 'FAKE GROCER (dummy)',
    credit: 'FAKE EMPLOYER (dummy)',
  },
  {
    file: 'qif.ts',
    label: 'QIF credit card',
    parse: () => parseQif(`!Type:CCard
D03/15/2026
T-19.99
PFAKE STREAMING (dummy)
^
D03/20/2026
T250.00
PFAKE CARD PAYMENT (dummy)
^`),
    purchase: 'FAKE STREAMING (dummy)',
    credit: 'FAKE CARD PAYMENT (dummy)',
  },
];

function find(txns: ParsedTransaction[], text: string): ParsedTransaction {
  const hit = txns.find((t) => t.description.includes(text) || (t as { merchant_name?: string }).merchant_name === text);
  if (!hit) throw new Error(`no parsed row for "${text}" in ${JSON.stringify(txns.map((t) => t.description))}`);
  return hit;
}

describe('NN-07 amount sign: negative = expense, positive = income/credit, for every importer', () => {
  for (const c of CASES) {
    test(`${c.file}: ${c.label}`, () => {
      const txns = c.parse();
      const purchase = find(txns, c.purchase);
      const credit = find(txns, c.credit);
      expect(Number.isFinite(purchase.amount)).toBe(true);
      expect(Number.isFinite(credit.amount)).toBe(true);
      expect(purchase.amount).toBeLessThan(0);
      expect(credit.amount).toBeGreaterThan(0);
    });
  }

  // FINDING: generic.ts:10 AMOUNT_PATTERNS also matches the literal headers "Debit" and "Credit", so a CSV with
  // "Debit,Credit" columns takes the Debit column as a single signed amount (generic.ts:65, :84 hasSeparateDebitCredit
  // is false) and every credit row, whose Debit cell is empty, parses to NaN and is silently dropped (generic.ts:101).
  // The existing generic-parser test sidesteps it with Withdrawal/Deposit headers. Expected-fail until fixed; when
  // this starts passing, `test.failing` fails and it should become a plain case above.
  test.failing('generic.ts: literal "Debit" / "Credit" columns keep the credit row (FINDING: credit dropped)', () => {
    const txns = parseGenericCSV([
      'Date,Description,Debit,Credit',
      '2026-02-15,FAKE HARDWARE (dummy),42.00,',
      '2026-02-16,FAKE DEPOSIT (dummy),,900.00',
    ].join('\n'));
    expect(find(txns, 'FAKE HARDWARE (dummy)').amount).toBeLessThan(0);
    expect(find(txns, 'FAKE DEPOSIT (dummy)').amount).toBeGreaterThan(0);
  });

  // FINDING: generic.ts:113-114 negates EVERY amount of an already-signed file when more than 60% of its rows are
  // positive (meant for banks that export expenses as positive). A signed statement that is mostly deposits/refunds,
  // e.g. a savings account, comes out inverted: deposits become expenses. Expected-fail until fixed.
  test.failing('generic.ts: a credit-heavy signed CSV keeps its signs (FINDING: whole file negated)', () => {
    const txns = parseGenericCSV([
      'Date,Description,Amount',
      '2026-02-01,FAKE TRANSFER FEE (dummy),-5.00',
      '2026-02-02,FAKE DEPOSIT ONE (dummy),400.00',
      '2026-02-03,FAKE DEPOSIT TWO (dummy),250.00',
    ].join('\n'));
    expect(find(txns, 'FAKE TRANSFER FEE (dummy)').amount).toBeLessThan(0);
    expect(find(txns, 'FAKE DEPOSIT ONE (dummy)').amount).toBeGreaterThan(0);
  });

  test('amount.ts: parseAmount keeps the sign and reads accounting parentheses as negative', () => {
    expect(parseAmount('-1,234.56')).toBe(-1234.56);
    expect(parseAmount('$2,000.00')).toBe(2000);
    expect(parseAmount('(45.00)')).toBe(-45);
  });

  test('every parser file in src/tools/import/parsers/ has a sign case here (new importers cannot skip NN-07)', () => {
    const dir = join(import.meta.dir, '..', 'tools', 'import', 'parsers');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const covered = new Set([...CASES.map((c) => c.file), 'amount.ts']);
    const missing = files.filter((f) => !covered.has(f));
    expect(missing).toEqual([]);
  });
});
