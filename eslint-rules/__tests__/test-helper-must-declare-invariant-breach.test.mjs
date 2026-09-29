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

tester.run(
  'ready/test-helper-must-declare-invariant-breach',
  rules['test-helper-must-declare-invariant-breach'],
  {
    valid: [
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: [
          'export const __breaksInvariants = [',
          "  'singleton.sample.reset-for-tests',",
          '] as const',
          'export function __resetSampleForTests(): void {}',
        ].join('\n'),
      },
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: [
          'export const __noProductionInvariantBreach = true',
          'export function __stubPureHelperForTest(): void {}',
        ].join('\n'),
      },
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: 'export function resetSampleForTests(): void {}',
      },
    ],
    invalid: [
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: 'export function __resetSampleForTests(): void {}',
        errors: [{ messageId: 'testHelperMustDeclareInvariantBreach' }],
      },
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: 'export function __stubSampleForTest(): void {}',
        errors: [{ messageId: 'testHelperMustDeclareInvariantBreach' }],
      },
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: [
          'export const __breaksInvariants = [] as const',
          'export function __seedSampleForTests(): void {}',
        ].join('\n'),
        errors: [{ messageId: 'testHelperInvariantBreachMarkerEmpty' }],
      },
      {
        filename: 'src/main/modules/agent-control/sample.ts',
        code: [
          "export const __breaksInvariants = ['singleton.sample.reset-for-tests'] as const",
          'export const __noProductionInvariantBreach = true',
          'export function __forceFlushSampleForTests(): void {}',
        ].join('\n'),
        errors: [{ messageId: 'testHelperInvariantBreachMarkerConflict' }],
      },
    ],
  },
)
