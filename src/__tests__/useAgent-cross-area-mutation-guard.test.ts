/**
 * Stage W W4.6 — useAgent cross-area mutation guard (renderer-side test).
 *
 * The rule itself lives in `eslint-rules/no-cross-area-mutation.mjs` and its
 * fixture-driven test lives next to it
 * (`eslint-rules/__tests__/no-cross-area-mutation.test.mjs`). This file is
 * the renderer-side spec the W4 plan calls for: it imports the rule module
 * directly, runs it against a violating fixture string, and asserts the
 * rule fires with the expected message id.
 *
 * Plan: docs/superpowers/plans/2026-05-22-W4-useagent-ownership-implementation.md §3.6
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'

import { rules } from '../../eslint-rules/index.mjs'

const RULE_NAME = 'ready/no-cross-area-mutation'

function lintSource(filename: string, code: string) {
  const linter = new Linter()
  return linter.verify(
    code,
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      plugins: {
        ready: { rules: { 'no-cross-area-mutation': rules['no-cross-area-mutation'] } },
      },
      rules: {
        [RULE_NAME]: 'error',
      },
    },
    { filename },
  )
}

test('W4.6 — rule fires when a consumer imports two area actions in one declaration', () => {
  const messages = lintSource(
    'src/renderer/components/__fixtures__/cross-area-consumer.tsx',
    [
      "import { setInputValue, setSendCoalescingEnabled } from '../../stores/useAgent'",
      "export function Demo(v: string) { setInputValue(v); setSendCoalescingEnabled(true) }",
    ].join('\n'),
  )

  assert.equal(messages.length, 1, 'rule produces exactly one diagnostic')
  assert.equal(messages[0]?.ruleId, RULE_NAME, 'diagnostic comes from no-cross-area-mutation')
  assert.match(
    messages[0]?.message ?? '',
    /cross-area mutation/,
    'diagnostic message names the cross-area violation',
  )
})

test('W4.6 — rule does not fire when the consumer stays inside one area', () => {
  const messages = lintSource(
    'src/renderer/components/__fixtures__/single-area-consumer.tsx',
    [
      "import { setInputValue, setComposerDraft } from '../../stores/useAgent'",
      "export function Demo(v: string) { setInputValue(v); setComposerDraft(v) }",
    ].join('\n'),
  )

  assert.equal(messages.length, 0, 'no diagnostic for same-area imports')
})

test('W4.6 — rule is silent on selector / type-only imports', () => {
  const messages = lintSource(
    'src/renderer/components/__fixtures__/read-only-consumer.tsx',
    [
      "import { useAgent, getSessionSlice, type SessionSlice } from '../../stores/useAgent'",
      "export function Demo() {",
      "  const slice: SessionSlice = useAgent(getSessionSlice)",
      "  return slice.inputValue.length",
      "}",
    ].join('\n'),
  )

  assert.equal(messages.length, 0, 'no diagnostic when no action is imported')
})
