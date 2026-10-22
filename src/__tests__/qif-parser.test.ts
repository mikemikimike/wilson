import { describe, expect, test } from 'bun:test';
import { parseQif, parseQifDate, isQifContent } from '../tools/import/parsers/qif.js';

// Mirror of the parser's simpleHash, to pin legacy external ids.
function legacyId(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return `qif-${Math.abs(hash).toString(36)}`;
}

describe('QIF Parser', () => {
  describe('Basic transactions', () => {
    const qifContent = `!Type:Bank
D03/15/2026
T-85.50
PWhole Foods Market
LFood:Groceries
MGrocery shopping
^
D03/10/2026
T3500.00
PEmployer Inc
LIncome:Salary
^
D03/20/2026
T-150.00
N1234
PJohn Smith
LPersonal
MRent payment
C*
^`;

    test('returns 3 transactions', () => {
      const txns = parseQif(qifContent);
      expect(txns).toHaveLength(3);
    });

    test('first transaction fields', () => {
      const txns = parseQif(qifContent);
      const first = txns[0];
      expect(first.date).toBe('2026-03-15');
      expect(first.description).toBe('Whole Foods Market');
      expect(first.amount).toBe(-85.50);
      expect(first.bank).toBe('qif');
      expect(first.category).toBe('Food:Groceries');
      expect(first.merchant_name).toBe('Whole Foods Market');
    });

    test('second transaction — income', () => {
      const txns = parseQif(qifContent);
      const second = txns[1];
      expect(second.amount).toBe(3500.00);
      expect(second.category).toBe('Income:Salary');
    });

    test('third transaction — check number', () => {
      const txns = parseQif(qifContent);
      const third = txns[2];
      expect(third.check_number).toBe('1234');
      expect(third.external_id).toBe('1234');
    });
  });

  describe('Split transactions', () => {
    const splitQif = `!Type:Bank
D03/25/2026
T-200.00
PCostco
SFood:Groceries
EGrocery items
$-150.00
SGeneral:Household
EHousehold supplies
$-50.00
^`;

    test('produces one entry per split', () => {
      const txns = parseQif(splitQif);
      expect(txns).toHaveLength(2);
    });

    test('split amounts are correct', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].amount).toBe(-150.00);
      expect(txns[1].amount).toBe(-50.00);
    });

    test('splits inherit parent payee', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].description).toBe('Costco');
      expect(txns[1].description).toBe('Costco');
      expect(txns[0].merchant_name).toBe('Costco');
      expect(txns[1].merchant_name).toBe('Costco');
    });

    test('splits have their own categories', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].category).toBe('Food:Groceries');
      expect(txns[1].category).toBe('General:Household');
    });
  });

  describe('Date parsing', () => {
    test('M/D\'YY format', () => {
      expect(parseQifDate("1/5'26")).toBe('2026-01-05');
    });

    test('MM/DD/YYYY format', () => {
      expect(parseQifDate('01/05/2026')).toBe('2026-01-05');
    });

    test('M-D-YYYY format', () => {
      expect(parseQifDate('1-5-2026')).toBe('2026-01-05');
    });

    test('MM/DD/YYYY end of year', () => {
      expect(parseQifDate('12/31/2025')).toBe('2025-12-31');
    });

    test('M-D\'YY format', () => {
      expect(parseQifDate("3-5'26")).toBe('2026-03-05');
    });

    test('single digit month and day with full year', () => {
      expect(parseQifDate('3/5/2026')).toBe('2026-03-05');
    });

    test('space-padded apostrophe date', () => {
      expect(parseQifDate("1/ 5'26")).toBe('2026-01-05');
      expect(parseQifDate(" 3/15'26")).toBe('2026-03-15');
    });

    test('two-digit slash year before the pivot is 20YY', () => {
      expect(parseQifDate('1/5/26')).toBe('2026-01-05');
    });

    test('two-digit slash year at or after the pivot is 19YY', () => {
      expect(parseQifDate('12/31/99')).toBe('1999-12-31');
      expect(parseQifDate('6/ 1/85')).toBe('1985-06-01');
    });

    test('Quicken single-digit apostrophe years for 2000-2009', () => {
      expect(parseQifDate("3/ 1' 8")).toBe('2008-03-01');
      expect(parseQifDate("3/24' 0")).toBe('2000-03-24');
    });
  });

  describe('Category to PFC mapping', () => {
    test('maps Food:Groceries to PFC code', () => {
      const qif = `!Type:Bank
D01/01/2026
T-50.00
PStore
LFood:Groceries
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBe('FOOD_AND_DRINK_GROCERIES');
    });

    test('unknown category has no PFC mapping', () => {
      const qif = `!Type:Bank
D01/01/2026
T-50.00
PStore
LUnknown:Something
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBeUndefined();
    });

    test('maps bare category name (Income)', () => {
      const qif = `!Type:Bank
D01/01/2026
T1000.00
PEmployer
LIncome
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBe('INCOME_OTHER_INCOME');
    });
  });

  describe('isQifContent detection', () => {
    test('detects !Type:Bank header', () => {
      expect(isQifContent('!Type:Bank\nD01/01/2026\nT-50\n^')).toBe(true);
    });

    test('detects !Type:CCard header', () => {
      expect(isQifContent('!Type:CCard\nD01/01/2026\n')).toBe(true);
    });

    test('rejects CSV content', () => {
      expect(isQifContent('Date,Description,Amount\n01/01/2026,Store,50.00')).toBe(false);
    });

    test('detects QIF pattern without type header', () => {
      expect(isQifContent('D01/01/2026\nT-50.00\nPStore\n^')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('missing payee uses memo as description', () => {
      const qif = `!Type:Bank
D01/01/2026
T-25.00
MSome memo note
^`;
      const txns = parseQif(qif);
      expect(txns[0].description).toBe('Some memo note');
    });

    test('missing payee and memo uses Unknown', () => {
      const qif = `!Type:Bank
D01/01/2026
T-10.00
^`;
      const txns = parseQif(qif);
      expect(txns[0].description).toBe('Unknown');
    });

    test('empty records (just ^) are skipped', () => {
      const qif = `!Type:Bank
^
D01/01/2026
T-10.00
PStore
^
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
    });

    test('credit card type header is accepted', () => {
      const qif = `!Type:CCard
D01/01/2026
T-75.00
PAmazon
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].bank).toBe('qif');
    });

    test('no trailing ^ still produces transaction', () => {
      const qif = `!Type:Bank
D06/15/2026
T-30.00
PCoffee Shop`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('Coffee Shop');
    });

    test('transaction with no amount defaults to 0', () => {
      const qif = `!Type:Bank
D01/01/2026
PSomething
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].amount).toBe(0);
    });

    test('amounts with thousands separators are parsed fully', () => {
      const qif = `!Type:Bank
D01/15/2026
T-1,234.56
PRent
^
D01/16/2026
T-2,000.00
PSplit
S Housing
$-1,500.00
S Utilities
$-500.00
^`;
      const txns = parseQif(qif);
      expect(txns.map((t) => t.amount)).toEqual([-1234.56, -1500, -500]);
    });
  });

  describe('Non-transaction sections', () => {
    test('category list records are not transactions', () => {
      const qif = `!Type:Cat
NFood
DFood expenses
E
^
NIncome
DIncome
I
^
!Type:Bank
D03/15/2026
T-85.50
PWhole Foods Market
LFood
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].date).toBe('2026-03-15');
    });

    test('investment records are skipped, not read as bank rows with N as a check number', () => {
      const qif = `!Type:Invst
D03/01/2026
NBuy
YACME Index Fund
I100.00
Q2
T200.00
^
!Type:Bank
D03/02/2026
T-10.00
PCoffee
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('Coffee');
    });

    test('memorized payees and price lists are skipped', () => {
      const qif = `!Type:Memorized
KC
PWhole Foods Market
LFood
T-50.00
^
!Type:Prices
"ACME",100.00," 3/ 1'26"
^
!Type:CCard
D03/03/2026
T-20.00
PBookstore
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('Bookstore');
    });

    test('classic-Mac CR-only line endings parse', () => {
      const txns = parseQif("!Type:Bank\rD03/15/2026\rT-1.00\rPGum\r^\r");
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('Gum');
    });

    test('a file with no !Type header is still parsed as a bank register', () => {
      const txns = parseQif(`D03/15/2026\nT-1.00\nPGum\n^`);
      expect(txns).toHaveLength(1);
    });
  });

  describe('Multi-account exports', () => {
    const qif = `!Option:AutoSwitch
!Account
NFixture Checking
TBank
^
NFixture Card
TCCard
^
!Clear:AutoSwitch
!Account
NFixture Checking
TBank
^
!Type:Bank
D03/01/2026
T-40.00
PGrocer
^
!Account
NFixture Card
TCCard
^
!Type:CCard
D03/02/2026
T-15.00
PCinema
^`;

    test('each row carries its account name', () => {
      const txns = parseQif(qif);
      expect(txns.map((t) => [t.description, t.account_name])).toEqual([
        ['Grocer', 'Fixture Checking'],
        ['Cinema', 'Fixture Card'],
      ]);
    });

    test('the AutoSwitch account list does not assign an account', () => {
      const listOnly = `!Option:AutoSwitch
!Account
NFixture Checking
TBank
^
!Clear:AutoSwitch
!Type:Bank
D03/01/2026
T-1.00
PGum
^`;
      expect(parseQif(listOnly)[0].account_name).toBeUndefined();
    });

    test('single-account files keep account_name undefined', () => {
      expect(parseQif(`!Type:Bank\nD03/01/2026\nT-1.00\nPGum\n^`)[0].account_name).toBeUndefined();
    });
  });

  describe('Transfers', () => {
    test('bracketed category is a transfer out when negative', () => {
      const [t] = parseQif(`!Type:Bank\nD03/01/2026\nT-500.00\nPTransfer\nL[Fixture Savings]\n^`);
      expect(t.category).toBe('[Fixture Savings]');
      expect(t.category_detailed).toBe('TRANSFER_OUT_OTHER_TRANSFER_OUT');
    });

    test('bracketed category with a class suffix is a transfer in when positive', () => {
      const [t] = parseQif(`!Type:Bank\nD03/01/2026\nT500.00\nPTransfer\nL[Fixture Checking]/Business\n^`);
      expect(t.category_detailed).toBe('TRANSFER_IN_OTHER_TRANSFER_IN');
    });

    test('a transfer split inside a split transaction', () => {
      const txns = parseQif(`!Type:Bank
D03/01/2026
T-300.00
PPaycheck adjustments
SFood:Groceries
$-100.00
S[Fixture Savings]
$-200.00
^`);
      expect(txns[0].category_detailed?.startsWith('TRANSFER_') ?? false).toBe(false);
      expect(txns[1].category_detailed).toBe('TRANSFER_OUT_OTHER_TRANSFER_OUT');
    });
  });

  describe('External ID uniqueness', () => {
    const ids = (qif: string) => parseQif(qif).map((t) => t.external_id);

    test('two identical transactions get distinct ids, and the first keeps the legacy id', () => {
      const one = `D03/01/2026\nT-5.00\nPCoffee\n^`;
      const [legacy] = ids(one);
      const both = ids(`${one}\n${one}`);
      expect(both[0]).toBe(legacy);
      expect(new Set(both).size).toBe(2);
    });

    test('splits of a check-numbered transaction get distinct ids', () => {
      const out = ids(`!Type:Bank
D03/01/2026
T-150.00
N1234
PLandlord
SHousing:Rent
$-100.00
SUtilities
$-50.00
^`);
      expect(out[0]).toBe('1234');
      expect(new Set(out).size).toBe(2);
    });

    test('the same check number in two accounts does not collide', () => {
      const out = ids(`!Account
NFixture Checking
TBank
^
!Type:Bank
D03/01/2026
T-10.00
N1001
PA
^
!Account
NFixture Joint
TBank
^
!Type:Bank
D03/01/2026
T-10.00
N1001
PA
^`);
      expect(new Set(out).size).toBe(2);
      expect(out.every((id) => id?.startsWith('qif-chk-'))).toBe(true);
    });

    test('ids for dates the old parser left raw are unchanged (padded date)', () => {
      // Legacy parser hashed the raw trimmed date string for dates it could not parse.
      const [t] = parseQif(`!Type:Bank\nD 3/ 1'26\nT-5.00\nPCoffee\n^`);
      expect(t.date).toBe('2026-03-01');
      expect(t.external_id).toBe(parseQif(`!Type:Bank\nD3/ 1'26\nT-5.00\nPCoffee\n^`)[0].external_id);
      expect(t.external_id).toBe(legacyId("3/ 1'26|Coffee|-5"));
    });

    test('word-valued N fields (EFT, ATM) do not become date-less ids', () => {
      const jan = parseQif(`D1/5'26\nT-50.00\nNEFT\nPGym\n^`)[0];
      const feb = parseQif(`D2/5'26\nT-80.00\nNEFT\nPPower Co\n^`)[0];
      expect(jan.external_id).not.toBe(feb.external_id);
      expect(jan.check_number).toBe('EFT');
    });

    test('ids are stable across re-parses of the same file', () => {
      const qif = `D03/01/2026\nT-5.00\nPCoffee\n^\nD03/01/2026\nT-5.00\nPCoffee\n^`;
      expect(ids(qif)).toEqual(ids(qif));
    });
  });
});
