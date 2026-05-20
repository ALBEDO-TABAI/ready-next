/**
 * Stage U PR U1.4 — turn-engine reminder text delegation.
 *
 * Asserts that the pet stickynote / browser task correction reminder
 * texts no longer live as string literals in turn-engine.ts, and that
 * the SystemReminderRegistry-adjacent composer modules expose them.
 *
 * Source-grep structural test (CLAUDE.md §6.4). Paired with the runtime
 * gate `scripts/check-turn-engine-no-domain-branch.cjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PET_STICKYNOTE_RETRY_REMINDER_TEXT,
  composePetStickynoteRetryReminder,
} from '../main/modules/agent-control/system-reminders/pet-stickynote-retry-reminder'
import {
  BROWSER_TASK_CORRECTION_REMINDER_TEXT,
  composeBrowserTaskCorrectionReminder,
} from '../main/modules/agent-control/system-reminders/browser-task-correction-reminder'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readWorkspaceFile(rel: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage U §0.7: source-grep is permitted as a structural gate when paired with a runtime gate. This test pairs with check-turn-engine-no-domain-branch.cjs (U1.4).
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

test('U1.4 turn-engine.ts no longer contains pet stickynote reminder literal', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  assert.doesNotMatch(source, /宠物便利贴/, 'pet stickynote reminder text must be relocated out of turn-engine.ts')
  assert.doesNotMatch(source, /pet_show_sticky_note/, 'pet_show_sticky_note tool name must not appear as a literal in turn-engine.ts')
})

test('U1.4 turn-engine.ts no longer contains browser task correction reminder literal', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  assert.doesNotMatch(source, /当前任务是浏览器任务/, 'browser correction reminder text must be relocated')
  assert.doesNotMatch(source, /browser_search、browser_navigate/, 'browser_* example list must not appear as a literal in turn-engine.ts')
})

test('U1.4 pet stickynote composer returns canonical text', () => {
  const result = composePetStickynoteRetryReminder()
  assert.ok(result, 'composer must return non-null reminder')
  assert.ok(result?.includes(PET_STICKYNOTE_RETRY_REMINDER_TEXT.slice(0, 20)),
    'composer output must contain canonical reminder text')
  assert.match(result || '', /pet_show_sticky_note/, 'composer output must mention target tool')
})

test('U1.4 browser task correction composer returns canonical text', () => {
  const result = composeBrowserTaskCorrectionReminder()
  assert.ok(result, 'composer must return non-null reminder')
  assert.ok(result?.includes(BROWSER_TASK_CORRECTION_REMINDER_TEXT.slice(0, 20)),
    'composer output must contain canonical reminder text')
  assert.match(result || '', /browser_\*/, 'composer output must mention browser_* tool family')
})

test('U1.4 turn-engine.ts imports the relocated composers', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  assert.match(source, /from '\.\/system-reminders\/pet-stickynote-retry-reminder'/, 'turn-engine must import pet composer')
  assert.match(source, /from '\.\/system-reminders\/browser-task-correction-reminder'/, 'turn-engine must import browser composer')
})
