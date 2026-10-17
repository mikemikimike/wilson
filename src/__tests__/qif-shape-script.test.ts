import { describe, expect, test, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { makeTmpPath } from './helpers.js';

// The shape script is run against real financial data; it must only ever print structure.
const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'quicken', 'qif-shape.ts');

function runShape(content: string): string {
  const fp = makeTmpPath('.qif');
  writeFileSync(fp, content);
  tmpFiles.push(fp);
  const proc = Bun.spawnSync(['bun', SCRIPT, fp]);
  return proc.stdout.toString() + proc.stderr.toString();
}

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { unlinkSync(f); } catch {}
  }
  tmpFiles.length = 0;
});

describe('scripts/quicken/qif-shape.ts', () => {
  test('never prints payees, amounts, or account names, even for CR-only files', () => {
    const out = runShape('!Account\rNSecret Checking\rTBank\r^\r!Type:Bank\rD1/5\'26\rT-1234.56\rPReal Payee\r^\r');
    expect(out).not.toContain('Real Payee');
    expect(out).not.toContain('1234.56');
    expect(out).not.toContain('Secret Checking');
  });

  test('an unrecognized ! line is counted, not echoed', () => {
    const out = runShape('!Type:Bank Real Payee 1234.56\nD1/5\'26\nT-1.00\nPGum\n^\n');
    expect(out).not.toContain('Real Payee');
    expect(JSON.parse(out).otherBangLines).toBe(1);
  });

  test('reports records per section so skipped investment records are visible', () => {
    const out = JSON.parse(runShape('!Type:Invst\nD1/5\'26\nNDiv\nT10.00\n^\n!Type:Bank\nD1/5\'26\nT-1.00\nPGum\n^\n'));
    expect(out.recordsBySection).toEqual({ '!Type:Invst': 1, '!Type:Bank': 1 });
    expect(out.transactions).toBe(1);
  });
});
