import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardColumnParent, nextModalStack } from '../mcp/confirmation-card.js';
import {
  AgentFormSession,
  agentSubmitEntries,
  buildFormArgs,
  isBrowserAgentFill,
  readFill,
} from '../dashboard/declarative-submit-core.js';

/**
 * Live spike (Chrome 154, agent-browser `webmcp invoke judge_interaction`): the `propose_judgment` form lives in the
 * Training detail panel, a modal <dialog>.
 *
 *  1. The approval card was drawn BEHIND the panel and could not be clicked ("<dialog open> intercepts pointer events"):
 *     a modal dialog is in the top layer, above any z-index, and makes everything outside it inert. The card column is
 *     now a manual popover (top layer) that lives inside the topmost open modal dialog.
 *  2. The agent's values never showed in the form: the hold's re-render put the controlled fields' old state back before
 *     their onChange. The form now sets its state from the agent's fill record in the same event, shows only that record,
 *     and its agent submit carries only that record (plus the read-only interaction id), never text a person left or typed.
 */

const src = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');

describe('the card column above a modal dialog', () => {
  test('no modal open: the column lives in <body>', () => {
    expect(cardColumnParent(nextModalStack([], []), 'body')).toBe('body');
  });

  test('a modal opens: the column moves into it; it closes: back to <body>', () => {
    const open = nextModalStack<string>([], ['panel']);
    expect(cardColumnParent(open, 'body')).toBe('panel');
    expect(cardColumnParent(nextModalStack(open, []), 'body')).toBe('body');
  });

  test('a second modal opened later is on top, even if it comes first in document order', () => {
    const first = nextModalStack<string>([], ['panel']);
    const both = nextModalStack(first, ['kill-switch', 'panel']);
    expect(both).toEqual(['panel', 'kill-switch']);
    expect(cardColumnParent(both, 'body')).toBe('kill-switch');
    // The top one closes: back into the panel.
    expect(cardColumnParent(nextModalStack(both, ['panel']), 'body')).toBe('panel');
  });

  test('the bridge shows the column as a manual popover and places it inside the topmost modal (source guard)', () => {
    const bridge = src('dashboard/webmcp-bridge.ts');
    expect(bridge).toContain("host.setAttribute('popover', 'manual')");
    expect(bridge).toContain("document.querySelectorAll('dialog:modal')");
    expect(bridge).toMatch(/cardColumnParent<Element>\(modalStack, document\.body\)/);
    expect(bridge).toContain('showPopover()');
    // Re-placed when a dialog opens / closes (`open`) or is removed with the column inside it.
    expect(bridge).toMatch(/new MutationObserver\(placeCardHost\)/);
    expect(bridge).toContain("attributeFilter: ['open']");
  });
});

const SCHEMA = {
  type: 'object',
  properties: {
    interaction_id: { type: 'number' },
    rating: { type: 'number' },
    preference: { type: 'string' },
    rationale: { type: 'string' },
    judge_model: { type: 'string' },
  },
};

/** The judge form as Chrome 154 drives it: trusted plain Event('input') on an unfocused field. */
function agentFill(session: AgentFormSession, name: string, value: string) {
  expect(isBrowserAgentFill({ isTrusted: true, isInputEvent: false, targetFocused: false })).toBe(true);
  session.apply({ type: 'agentfill' }, { policy: 'ask', take: () => undefined });
  const fill = readFill({ name, value, type: name === 'rationale' ? 'textarea' : 'select-one' });
  if (fill) session.noteFill(fill.name, fill.value);
}

describe('propose_judgment: the agent submit carries only what the agent filled', () => {
  test('agentSubmitEntries keeps only the read-only interaction id of a proposal form', () => {
    const dom: Array<[string, unknown]> = [
      ['interaction_id', '42'],
      ['rating', ''],
      ['rationale', 'the person typed this'],
    ];
    expect(agentSubmitEntries('propose_judgment', dom)).toEqual([['interaction_id', '42']]);
  });

  test('any other form reads all of its entries', () => {
    const dom: Array<[string, unknown]> = [['amount', '100'], ['category', 'Food']];
    expect(agentSubmitEntries('set_budget', dom)).toEqual(dom);
  });

  test('text a person left in a field the agent did not fill is not submitted as the agent\'s', () => {
    const session = new AgentFormSession('propose_judgment');
    agentFill(session, 'rating', '4');
    agentFill(session, 'preference', 'chosen');
    const dom: Array<[string, unknown]> = [
      ['interaction_id', '42'],
      ['rating', ''], // the controlled field was reset by the re-render
      ['preference', ''],
      ['judge_model', ''],
      ['rationale', 'a person left this here'],
    ];
    const args = buildFormArgs({ entries: agentSubmitEntries('propose_judgment', dom), schema: SCHEMA, fills: session.agentFills() });
    expect(args).toEqual({ interaction_id: 42, rating: 4, preference: 'chosen' });
  });

  test('a person editing a filled field does not replace the agent\'s value on a proposal form', () => {
    const session = new AgentFormSession('propose_judgment');
    agentFill(session, 'rating', '2');
    session.noteHumanEdit('rating');
    expect(session.agentFills().get('rating')).toBe('2');
    const args = buildFormArgs({ entries: agentSubmitEntries('propose_judgment', [['interaction_id', '7'], ['rating', '5']]), schema: SCHEMA, fills: session.agentFills() });
    expect(args).toEqual({ interaction_id: 7, rating: 2 });
  });

  test('on a mutating form a person\'s edit still makes the field theirs (unchanged)', () => {
    const session = new AgentFormSession('set_budget');
    session.apply({ type: 'agentfill' }, { policy: 'ask', take: () => undefined });
    session.noteFill('amount', '100');
    session.noteHumanEdit('amount');
    expect(session.agentFills().has('amount')).toBe(false);
  });
});

describe('the judge form shows the agent\'s values (source guards)', () => {
  test('the hook hands the fill record to the form in the same event as the hold', () => {
    const hook = src('dashboard/ui/src/agent/useDeclarativeTool.ts');
    expect(hook).toContain('onAgentFill?: (fills: ReadonlyMap<string, string>) => void;');
    expect(hook).toMatch(/session\.noteFill\(fill\.name, fill\.value\);\s*\n\s*\/\/[^\n]*\n\s*if \(session\.agentFills\(\)\.has\(fill\.name\)\) optionsRef\.current\.onAgentFill\?\.\(session\.agentFills\(\)\);/);
    expect(hook).toContain('agentSubmitEntries(tool, new FormData(formEl).entries())');
  });

  test('the form sets every field from the record and ignores a person\'s edit while the agent\'s values are shown', () => {
    const form = src('dashboard/ui/src/components/judge/JudgeInteractionForm.tsx');
    for (const [setter, name] of [['setRating', 'rating'], ['setPreference', 'preference'], ['setRationale', 'rationale'], ['setJudgeModel', 'judge_model']]) {
      expect(form).toContain(`${setter}(fills.get('${name}') ?? '')`);
      expect(form).toContain(`onChange={edit(${setter})}`);
    }
    expect(form).toContain('if (!declarative.agentTouched) set(e.target.value);');
    // Never `disabled` / `readOnly` on an agent-fillable field: Chrome would drop it from the schema and cancel the call.
    expect(form).not.toMatch(/name="(rating|preference|rationale|judge_model)"[^>]*(disabled|readOnly)/);
  });
});
