/**
 * Stage W W4.6 — `ready/no-cross-area-mutation` rule tests.
 *
 * Two fixtures from the W4 plan §3.6:
 *
 *   Fixture 1 (rejected): a file importing setInputValue (sessionSlice) +
 *                         setSendCoalescingEnabled (pendingSend). Must fire
 *                         with the cross-area-mutation message.
 *   Fixture 2 (accepted): a file importing only setInputValue + a selector
 *                         from the same / no area. Must NOT fire.
 *
 * Plan: docs/superpowers/plans/2026-05-22-W4-useagent-ownership-implementation.md §3.6
 */

import test from 'node:test'

import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'

import { rules } from '../index.mjs'

RuleTester.afterAll = test.after
RuleTester.describe = test.describe
RuleTester.it = test.it

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
})

tester.run('ready/no-cross-area-mutation', rules['no-cross-area-mutation'], {
  valid: [
    {
      // Fixture 2 — accepted: only one area (sessionSlice) plus selector reads.
      filename: 'src/renderer/components/__fixtures__/single-area-consumer.tsx',
      code: [
        "import { setInputValue, getSessionSlice, useAgent } from '../../stores/useAgent'",
        "export function Demo() {",
        "  const slice = useAgent(getSessionSlice)",
        "  return slice.inputValue.length",
        "}",
      ].join('\n'),
    },
    {
      // Same-area: two actions from sessionSlice — allowed.
      filename: 'src/renderer/components/__fixtures__/same-area-consumer.tsx',
      code: [
        "import { setInputValue, setComposerDraft } from '../../stores/useAgent'",
        "export function Demo(v: string) { setInputValue(v); setComposerDraft(v) }",
      ].join('\n'),
    },
    {
      // Pure selector + type import — no actions at all.
      filename: 'src/renderer/components/__fixtures__/read-only-consumer.tsx',
      code: [
        "import { useAgent, getSessionSlice, type SessionSlice } from '../../stores/useAgent'",
        "export function Demo() {",
        "  const slice: SessionSlice = useAgent(getSessionSlice)",
        "  return slice.inputValue.length",
        "}",
      ].join('\n'),
    },
    {
      // Unrelated import (not useAgent) is not policed by the rule.
      filename: 'src/renderer/components/__fixtures__/unrelated-consumer.tsx',
      code: [
        "import { something } from 'some-other-module'",
        "export const x = something",
      ].join('\n'),
    },
  ],
  invalid: [
    {
      // Fixture 1 — rejected: sessionSlice action + pendingSend action.
      filename: 'src/renderer/components/__fixtures__/cross-area-consumer.tsx',
      code: [
        "import { setInputValue, setSendCoalescingEnabled } from '../../stores/useAgent'",
        "export function Demo(v: string) { setInputValue(v); setSendCoalescingEnabled(true) }",
      ].join('\n'),
      errors: [{ messageId: 'crossAreaMutation' }],
    },
    {
      // Two areas via separate import declarations also caught.
      filename: 'src/renderer/components/__fixtures__/cross-area-multi-import.tsx',
      code: [
        "import { setInputValue } from '../../stores/useAgent'",
        "import { newSession } from '../../stores/useAgent'",
        "export function Demo(v: string) { setInputValue(v); newSession() }",
      ].join('\n'),
      errors: [{ messageId: 'crossAreaMutation' }],
    },
    {
      // Three areas — the rule reports on each area beyond the first.
      filename: 'src/renderer/components/__fixtures__/cross-area-three.tsx',
      code: [
        "import { setInputValue, newSession, addAttachments } from '../../stores/useAgent'",
        "export function Demo(v: string) { setInputValue(v); newSession(); addAttachments([]) }",
      ].join('\n'),
      errors: [
        { messageId: 'crossAreaMutation' },
        { messageId: 'crossAreaMutation' },
      ],
    },
  ],
})
