import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'

import { scanA0RuleViolations } from '../a0-rule-utils.mjs'
import { rules } from '../index.mjs'

const require = createRequire(import.meta.url)
const {
  checkTestingConventionsDoc,
} = require('../../scripts/check-testing-conventions-doc.cjs')

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
  'F break gate: invariant helper marker',
  rules['test-helper-must-declare-invariant-breach'],
  {
    valid: [],
    invalid: [
      {
        filename: 'src/main/modules/agent-control/skill-child-runner.ts',
        code: 'export function __resetSkillChildRunnerForTests(): void {}',
        errors: [{ messageId: 'testHelperMustDeclareInvariantBreach' }],
      },
      {
        filename: 'src/main/modules/agent-control/new-helper.ts',
        code: 'export function __stubNewHelperForTest(): void {}',
        errors: [{ messageId: 'testHelperMustDeclareInvariantBreach' }],
      },
    ],
  },
)

tester.run('F break gate: source-grep test freeze', rules['no-source-grep-test'], {
  valid: [],
  invalid: [
    {
      filename: 'src/__tests__/new-source-grep-contract.test.ts',
      code: [
        "import { readFileSync } from 'node:fs'",
        "const source = readFileSync('src/main/modules/agent-control/turn-engine.ts', 'utf8')",
        'assert.match(source, /executeToolBatch/)',
      ].join('\n'),
      errors: [{ messageId: 'noSourceGrepTest' }],
    },
  ],
})

test('F break gate: baseline scanner catches a new source-grep test', () => {
  const findings = scanA0RuleViolations({
    filePath: 'src/__tests__/new-source-grep-contract.test.ts',
    sourceText: [
      "import { readFileSync } from 'node:fs'",
      "const source = readFileSync('src/main/modules/agent-control/turn-engine.ts', 'utf8')",
      'assert.match(source, /executeToolBatch/)',
    ].join('\n'),
  })

  assert.equal(findings.some((finding) => finding.rule === 'ready/no-source-grep-test'), true)
})

test('F break gate: testing conventions checker catches a deleted doc', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-f-break-doc-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'CLAUDE.md'), '### 6.17 测试规约\n见 docs/superpowers/testing-conventions.md\n')
    writeFileSync(join(root, 'AGENTS.md'), '### 6.17 测试规约\n见 docs/superpowers/testing-conventions.md\n')

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /docs\/superpowers\/testing-conventions\.md is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
