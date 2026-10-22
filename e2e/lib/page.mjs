// Page-level helpers on top of AgentBrowser. Clicks, fills, selects and key presses all go through agent-browser
// (CDP input = trusted events, which the dashboard's guards require). `eval` is used only to READ the page and to
// tag an element we then click for real (data-e2e attribute), never to click.

/** Retry a page predicate until truthy or timeout. Returns the last value. */
export async function waitFor(ab, js, { timeout = 10_000, interval = 120, what } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await ab.eval(`(() => { try { return (${js}); } catch (e) { return false; } })()`); } catch (e) { last = false; }
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what ?? js}`);
    await sleep(interval);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const q = (s) => JSON.stringify(s);

/** Wait until `text` is visible inside `within` (CSS selector, default whole body). */
// Case-insensitive by default: section headings are uppercased by CSS (innerText follows text-transform).
export function expectText(ab, text, { within = 'body', timeout = 10_000, caseSensitive = false } = {}) {
  const hay = caseSensitive ? `(document.querySelector(${q(within)})?.innerText ?? '')` : `(document.querySelector(${q(within)})?.innerText ?? '').toLowerCase()`;
  const needle = caseSensitive ? q(text) : q(text.toLowerCase());
  return waitFor(ab, `${hay}.includes(${needle})`, { timeout, what: `text ${q(text)} in ${within}` });
}

export async function expectNoText(ab, text, { within = 'body', timeout = 5_000 } = {}) {
  return waitFor(ab, `!(document.querySelector(${q(within)})?.innerText ?? '').toLowerCase().includes(${q(text.toLowerCase())})`, { timeout, what: `text ${q(text)} to be gone from ${within}` });
}

export async function textOf(ab, sel = 'main') {
  return ab.eval(`document.querySelector(${q(sel)})?.innerText ?? ''`);
}

let tagSeq = 0;
/**
 * Find a visible element by exact trimmed text (or a predicate on its text) among `selector` inside `within`, tag it and
 * return a CSS selector for it. Throws when none matches.
 */
export async function tagByText(ab, text, { selector = 'button', within = 'body', exact = true, enabled = true, timeout = 10_000 } = {}) {
  const tag = `e2e-${++tagSeq}`;
  await waitFor(
    ab,
    `(() => {
      const root = document.querySelector(${q(within)}); if (!root) return false;
      const want = ${q(text)};
      const el = [...root.querySelectorAll(${q(selector)})].find((e) => {
        const t = (e.innerText ?? e.textContent ?? '').trim();
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (${enabled} && e.disabled) return false;
        return ${exact} ? t === want : t.includes(want);
      });
      if (!el) return false;
      el.setAttribute('data-e2e', ${q(tag)});
      return true;
    })()`,
    { timeout, what: `${selector} ${q(text)} in ${within}` },
  );
  return `[data-e2e="${tag}"]`;
}

/**
 * A real (trusted) click. When the element is not fully on screen it is scrolled into view first and given a moment
 * to settle: agent-browser computes the click point once, so clicking mid-scroll can land on the wrong row.
 */
export async function click(ab, sel) {
  const onScreen = await ab.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`);
  if (onScreen === false) {
    await ab.must(['scrollintoview', sel]);
    await sleep(250);
  }
  await ab.must(['click', sel]);
}

export async function clickText(ab, text, opts = {}) {
  const sel = await tagByText(ab, text, opts);
  await click(ab, sel);
  return sel;
}

/** Tag the first element matching `css` that satisfies the JS predicate body `pred` (gets `e`), return its selector. */
export async function tagWhere(ab, css, pred = 'true', { timeout = 10_000, what } = {}) {
  const tag = `e2e-${++tagSeq}`;
  await waitFor(
    ab,
    `(() => { const el = [...document.querySelectorAll(${q(css)})].find((e) => { return (${pred}); }); if (!el) return false; el.setAttribute('data-e2e', ${q(tag)}); return true; })()`,
    { timeout, what: what ?? `${css} where ${pred}` },
  );
  return `[data-e2e="${tag}"]`;
}

/** Switch tab the way a person does: click its TabBar button. */
export async function gotoTab(ab, label, readyText, { timeout = 15_000 } = {}) {
  await clickText(ab, label, { within: 'nav' });
  if (readyText) await expectText(ab, readyText, { within: 'main', timeout });
}

/**
 * Time a human mutation in the page: from the trusted pointer/key event that starts it to the first DOM state where
 * `doneJs` is true (a MutationObserver checks it on every DOM change). `act` performs the real click.
 * Returns ms (page clock, excludes CLI overhead).
 */
export async function timeMutation(ab, doneJs, act, { timeout = 15_000 } = {}) {
  await ab.eval(`(() => {
    const m = (window.__e2eMut = { t0: null, t1: null });
    const start = (e) => { if (e.isTrusted && m.t0 === null) m.t0 = performance.now(); };
    document.addEventListener('pointerdown', start, { capture: true, once: false });
    document.addEventListener('keydown', start, { capture: true, once: false });
    const check = () => { try { if (m.t0 !== null && m.t1 === null && (${doneJs})) { m.t1 = performance.now(); obs.disconnect(); } } catch {} };
    const obs = new MutationObserver(check);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    m.cleanup = () => { obs.disconnect(); document.removeEventListener('pointerdown', start, true); document.removeEventListener('keydown', start, true); };
    return true;
  })()`);
  await act();
  try {
    await waitFor(ab, 'window.__e2eMut && window.__e2eMut.t1 !== null', { timeout, what: `mutation confirmation (${doneJs})` });
    return await ab.eval('(() => { const m = window.__e2eMut; m.cleanup(); return Math.round((m.t1 - m.t0) * 10) / 10; })()');
  } catch (e) {
    await ab.eval('window.__e2eMut && window.__e2eMut.cleanup && window.__e2eMut.cleanup()').catch(() => {});
    throw e;
  }
}

/** Core Web Vitals + navigation timing for the current document (buffered observers). */
export const VITALS_JS = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const read = (type, fold) => new Promise((res) => {
    let acc = null;
    try {
      const po = new PerformanceObserver((l) => { acc = fold(acc, l.getEntries()); });
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); res(acc); }, 60);
    } catch { res(null); }
  });
  const lcp = await read('largest-contentful-paint', (a, es) => es[es.length - 1] ?? a);
  const cls = await read('layout-shift', (a, es) => (a ?? 0) + es.filter((e) => !e.hadRecentInput).reduce((s, e) => s + e.value, 0));
  return {
    ttfb: nav ? +(nav.responseStart - nav.startTime).toFixed(1) : null,
    fcp: fcp ? +fcp.startTime.toFixed(1) : null,
    lcp: lcp ? +lcp.startTime.toFixed(1) : null,
    cls: +(cls ?? 0).toFixed(4),
    transferKB: nav ? Math.round((nav.transferSize || nav.encodedBodySize || 0) / 1024) : null,
  };
})()`;

/** Horizontal overflow at the current viewport: page scroll and clipped elements. */
export const OVERFLOW_JS = `(() => {
  const vw = document.documentElement.clientWidth;
  const pageScroll = document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1;
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      wide.push((el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')).slice(0, 80) + ' right=' + Math.round(r.right));
    }
  }
  // Is any scroll container on screen scrollable sideways (a nested horizontal scroll)?
  const nested = [...document.querySelectorAll('body *')].filter((el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  }).length;
  return { viewport: vw, pageScroll, clippedCount: wide.length, clippedSample: wide.slice(0, 5), nestedScrollers: nested };
})()`;

/**
 * NN-10 phone layout audit. Run at 360x800 on a settled tab. Returns { viewport, count, offenders: [{rule, selector, w, h, text}] }.
 *   offscreen   (a) right edge past the viewport while NOT inside an intentional horizontal scroller (an ancestor with
 *               overflow-x auto/scroll). Only the outermost offender of a subtree is reported. Fixed elements skipped.
 *   clipped     (b) overflow-x hidden/clip with scrollWidth > clientWidth + 1 on an element that contains text
 *               (covers text-overflow ellipsis: "S." style truncation).
 *   narrowtext  (c) a text block narrower than 120 px whose text wraps to more than 4 lines.
 *   smalltarget (d) an interactive target smaller than 24x24 px (inline links inside running text are exempt, as in
 *               WCAG 2.5.8; visually-hidden 1px controls are skipped).
 */
export const LAYOUT_AUDIT_JS = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const visible = (r, cs) => r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  const sel = (el) => {
    const one = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    const parts = [];
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) parts.unshift(one(e));
    return parts.join(' > ').slice(0, 200);
  };
  const txt = (el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const push = (rule, el, r, extra) => out.push({ rule, selector: sel(el), w: Math.round(r.width), h: Math.round(r.height), text: txt(el), ...extra });
  const all = [...document.querySelectorAll('body *')];
  const inHScroller = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  const offSet = new Set();
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || (el.closest('svg') && tag !== 'svg')) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (!visible(r, cs) || cs.position === 'fixed') continue;
    if (r.right > vw + 1 && !inHScroller(el)) {
      offSet.add(el);
      if (!el.parentElement || !offSet.has(el.parentElement)) push('offscreen', el, r, { right: Math.round(r.right) });
    }
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1 && txt(el)) {
      push('clipped', el, r, { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (own) {
      const block = cs.display === 'inline' ? el.parentElement : el;
      const br = block.getBoundingClientRect();
      if (br.width < 120 && br.width > 0) {
        const rg = document.createRange(); rg.selectNodeContents(el);
        const lines = new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top / 4)));
        if (lines.size > 4) push('narrowtext', el, br, { lines: lines.size });
      }
    }
    const interactive = tag === 'button' || tag === 'select' || tag === 'textarea' || (tag === 'a' && el.hasAttribute('href')) || (tag === 'input' && el.type !== 'hidden') || /^(button|tab|link|checkbox|switch|menuitem|option)$/.test(el.getAttribute('role') || '');
    if (interactive && (r.width < 24 || r.height < 24) && !(r.width <= 1 && r.height <= 1) && cs.opacity !== '0') {
      const inline = tag === 'a' && cs.display === 'inline' && el.parentElement && (el.parentElement.innerText || '').trim().length > (el.innerText || '').trim().length + 3;
      if (!inline) push('smalltarget', el, r, {});
    }
  }
  const seen = new Set();
  const offenders = out.filter((o) => { const k = o.rule + o.selector + o.w + 'x' + o.h; if (seen.has(k)) return false; seen.add(k); return true; });
  return { viewport: vw, count: offenders.length, offenders: offenders.slice(0, 60) };
})()`;

/**
 * Clear a text input with real keystrokes. (agent-browser `fill <sel> ''` empties the value without an input event,
 * so React keeps the old filter; a person's Backspace does fire one.)
 */
export async function clearInput(ab, sel) {
  await ab.must(['focus', sel]);
  await ab.must(['press', 'End']);
  const n = await ab.eval(`(document.querySelector(${q(sel)})?.value ?? '').length`);
  for (let i = 0; i < n; i++) await ab.must(['press', 'Backspace']);
}
