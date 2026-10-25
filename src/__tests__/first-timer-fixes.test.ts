import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatModelNotice, MODELS_SETTINGS_LABEL } from '../dashboard/ui/src/lib/modelSetup.js';
import { weeklyChange } from '../dashboard/ui/src/lib/weeklyChange.js';
import type { ModelAvailability } from '../dashboard/ui/src/types.js';

/**
 * Fixes from the 2026-10-25 /first-timer runs (.verify/first-timer/2026-10-25-*): say before the first question that
 * Chat can't answer, don't show "↓0%" against an empty week, and keep Amount on screen in the phone transactions table.
 */

const UI = join(import.meta.dir, '../dashboard/ui/src');

function panel(availability: ModelAvailability | null, model: string | null = 'ollama:qwen3:8b') {
  return { tasks: [{ task: 'chat', model, availability }] };
}

describe('chatModelNotice', () => {
  test('names the missing model, the command, and where to pick another', () => {
    const n = chatModelNotice(panel('not-installed'))!;
    expect(n).toContain("Chat can't answer yet");
    expect(n).toContain('qwen3:8b');
    expect(n).toContain('`ollama pull qwen3:8b`');
    expect(n).toContain(MODELS_SETTINGS_LABEL);
  });

  test('says Ollama is not running when it did not answer', () => {
    expect(chatModelNotice(panel('unreachable'))).toContain("Ollama, which runs its model on this computer, isn't running");
  });

  test('says nothing when the model is installed, unchecked, or the panel is missing', () => {
    expect(chatModelNotice(panel('installed'))).toBeNull();
    expect(chatModelNotice(panel(null, 'claude-sonnet-4-5'))).toBeNull();
    expect(chatModelNotice(null)).toBeNull();
    expect(chatModelNotice({ tasks: [] })).toBeNull();
  });

  test('ChatTab shows it in the empty state, not while Agent access is off', () => {
    const tab = readFileSync(join(UI, 'tabs/ChatTab.tsx'), 'utf8');
    expect(tab).toContain("useApi<ModelsPanel>('/api/models')");
    expect(tab).toContain('modelNotice && !accessOff');
    expect(tab).toContain('data-testid="chat-model-notice"');
  });
});

describe('weeklyChange', () => {
  test('no spending either week: no percent', () => {
    expect(weeklyChange(0, 0, 0, 0)).toEqual({ kind: 'none' });
  });
  test('nothing last week: no baseline to compare', () => {
    expect(weeklyChange(-42, 0, -42, 0)).toEqual({ kind: 'no-baseline' });
  });
  test('both weeks: the rounded percent and direction', () => {
    expect(weeklyChange(-150, -100, 50, 50)).toEqual({ kind: 'change', down: false, percent: '50' });
    expect(weeklyChange(0, -100, -100, -100)).toEqual({ kind: 'change', down: true, percent: '100' });
  });
});

describe('phone transactions table', () => {
  test('description is narrow and wraps below sm so Amount stays on screen', () => {
    const tab = readFileSync(join(UI, 'tabs/TransactionsTab.tsx'), 'utf8');
    expect(tab.match(/max-w-\[9rem\] break-words sm:truncate sm:max-w-\[300px\]/g)?.length).toBe(2);
    expect(tab).toContain('<th className="text-right px-2 sm:px-4 py-3 font-medium">Amount</th>');
  });
});
