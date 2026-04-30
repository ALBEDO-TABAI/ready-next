import assert from 'node:assert/strict'
import test from 'node:test'

import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'

import { rules } from '../index.mjs'
import {
  findingKey,
  scanA0RuleViolations,
} from '../a0-rule-utils.mjs'

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

test('source-grep scanner uses file + rule + snippetHash as stable identity', () => {
  const [finding] = scanA0RuleViolations({
    filePath: 'src/__tests__/sample.test.ts',
    sourceText: [
      "import { readFileSync } from 'node:fs'",
      "const source = readFileSync('src/main/foo.ts', 'utf8')",
      'assert.match(source, /foo/)',
    ].join('\n'),
  })

  assert.equal(finding.rule, 'ready/no-source-grep-test')
  assert.equal(
    findingKey({ ...finding, line: finding.line + 50 }),
    findingKey(finding),
  )
})

test('source-grep scanner honors reviewed eslint disable reasons only', () => {
  const disabled = scanA0RuleViolations({
    filePath: 'src/__tests__/sample.test.ts',
    sourceText: [
      "import { readFileSync } from 'node:fs'",
      '// eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: electron IPC surface has no behavior harness yet',
      "const source = readFileSync('src/main/foo.ts', 'utf8')",
      'assert.match(source, /foo/)',
    ].join('\n'),
  })
  const missingReason = scanA0RuleViolations({
    filePath: 'src/__tests__/sample.test.ts',
    sourceText: [
      "import { readFileSync } from 'node:fs'",
      '// eslint-disable-next-line ready/no-source-grep-test',
      "const source = readFileSync('src/main/foo.ts', 'utf8')",
      'assert.match(source, /foo/)',
    ].join('\n'),
  })

  assert.equal(disabled.length, 0)
  assert.equal(missingReason.length, 1)
})

tester.run('ready/no-source-grep-test', rules['no-source-grep-test'], {
  valid: [
    {
      filename: 'src/__tests__/behavior.test.ts',
      code: "assert.equal(runThing(), 'ok')",
    },
    {
      filename: 'src/main/modules/agent-control/read-config.ts',
      code: "const text = readFileSync('config.json', 'utf8')",
    },
  ],
  invalid: [
    {
      filename: 'src/__tests__/source-contract.test.ts',
      code: [
        "import { readFileSync } from 'node:fs'",
        "const source = readFileSync('src/main/foo.ts', 'utf8')",
        'assert.match(source, /executeToolCall/)',
      ].join('\n'),
      errors: [{ messageId: 'noSourceGrepTest' }],
    },
  ],
})

tester.run('ready/no-legacy-backdoor', rules['no-legacy-backdoor'], {
  valid: [
    {
      filename: 'src/main/modules/agent-control/runtime.ts',
      code: "if (mode === 'compat') run()",
    },
    {
      filename: 'src/__tests__/legacy-fixture.test.ts',
      code: 'const legacy = true',
    },
  ],
  invalid: [
    {
      filename: 'src/main/modules/agent-control/runtime.ts',
      code: 'if (legacy) runCompatibilityPath()',
      errors: [{ messageId: 'noLegacyBackdoor' }],
    },
    {
      filename: 'src/shared/contracts.ts',
      code: 'interface Options { legacy?: boolean }',
      errors: [{ messageId: 'noLegacyBackdoor' }],
    },
  ],
})

tester.run('ready/no-migration-todo', rules['no-migration-todo'], {
  valid: [
    {
      filename: 'src/main/modules/tools/runtime.ts',
      code: '// TODO: handle explicit retry plan',
    },
  ],
  invalid: [
    {
      filename: 'src/main/modules/tools/runtime.ts',
      code: '// TODO migration: delete this later',
      errors: [{ messageId: 'noMigrationTodo' }],
    },
  ],
})

tester.run('ready/no-subagent-leak', rules['no-subagent-leak'], {
  valid: [
    {
      filename: 'src/main/modules/agent-control/sub-agent/sub-agent-runner.ts',
      code: "import { createContext } from './sub-agent-types'",
    },
    {
      filename: 'src/main/modules/agent-control/turn-engine.ts',
      code: "import { createContext } from './turn-frame'",
    },
    {
      filename: 'src/main/modules/agent-control/skill-child-runner.ts',
      code: "import { runSubAgent } from './sub-agent/sub-agent-runner'",
    },
    {
      filename: 'src/main/modules/agent-control/skill-child-sub-agent.ts',
      code: "import type { SubAgent } from './sub-agent/sub-agent-types'",
    },
    {
      filename: 'src/main/modules/agent-control/skill-child-sub-agent-factory.ts',
      code: "import { createSubAgentCleanupHandle } from './sub-agent/sub-agent-cleanup'",
    },
    {
      filename: 'src/shared/sub-agent-debug.ts',
      code: "import { createContext } from '../main/modules/agent-control/sub-agent/sub-agent-types'",
    },
  ],
  invalid: [
    {
      filename: 'src/main/modules/agent-control/turn-engine.ts',
      code: "import { runSubAgent } from './sub-agent/sub-agent-runner'",
      errors: [{ messageId: 'noSubagentLeak' }],
    },
    {
      filename: 'src/main/modules/agent-control/skill-domain-adapter.ts',
      code: "export { runSubAgent } from './sub-agent/sub-agent-runner'",
      errors: [{ messageId: 'noSubagentLeak' }],
    },
    {
      filename: 'src/main/modules/agent-control/run-coordinator.ts',
      code: "const runner = require('./sub-agent/sub-agent-runner')",
      errors: [{ messageId: 'noSubagentLeak' }],
    },
    {
      filename: 'src/main/modules/agent-control/run-coordinator.ts',
      code: "import runner = require('./sub-agent/sub-agent-runner')",
      errors: [{ messageId: 'noSubagentLeak' }],
    },
    {
      filename: 'src/main/modules/agent-control/runtime.ts',
      code: "async function load() { return import('./sub-agent/sub-agent-runner') }",
      errors: [{ messageId: 'noSubagentLeak' }],
    },
  ],
})
