// Calibration for LAYOUT_AUDIT_JS rule (a) `offscreen`. Run: node e2e/lib/layout-audit.calibrate.mjs (needs local Chrome).
// Uses a static page with no profile data, so it never touches ~/.openaccountant.
import { chromium } from 'playwright';
import { LAYOUT_AUDIT_JS } from './page.mjs';

const html = `<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0">
<div style="display:flex;flex-direction:column;height:400px;width:360px">
  <div id=tab class="flex-1 overflow-y-auto" style="flex:1;overflow-y:auto"><div id=wide style="width:600px;height:30px">wide in tab body</div></div>
</div>
<div class="overflow-x-auto" style="overflow-x:auto;width:360px"><div style="width:900px;height:30px">tab bar</div></div>
<div data-hscroll style="overflow-x:auto;width:360px"><div style="width:900px;height:30px">opt-in</div></div>
<div style="overflow-x:auto;width:360px" ><div style="width:900px;height:30px">inline style</div></div>`;

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
await page.setContent(html);
const r = await page.evaluate(LAYOUT_AUDIT_JS);
await browser.close();
const off = r.offenders.filter((o) => o.rule === 'offscreen');
const texts = off.map((o) => o.text);
const checks = [
  ['wide element in overflow-y-auto tab body is flagged', texts.includes('wide in tab body')],
  ['overflow-x-auto scroller exempt', !texts.includes('tab bar')],
  ['data-hscroll scroller exempt', !texts.includes('opt-in')],
  ['inline overflow-x scroller exempt', !texts.includes('inline style')],
];
let bad = 0;
for (const [n, ok] of checks) { console.log(ok ? 'PASS' : 'FAIL', n); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
