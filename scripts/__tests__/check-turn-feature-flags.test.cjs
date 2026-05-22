const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkTurnFeatureFlags,
} = require('../check-turn-feature-flags.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-turn-feature-flags.cjs')

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-turn-feature-flags-'))
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(root, relativePath)
      mkdirSync(fullPath.slice(0, fullPath.lastIndexOf('/')), { recursive: true })
      writeFileSync(fullPath, source)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts snapshot module and helper definition files', () => {
  withFixture(
    {
      'src/main/modules/agent-control/runtime-core/turn-feature-flags.ts': [
        "import { isChildResumeEnabled } from './skill-child-feature-flags'",
        "import { isChildInternalStrictAdmissionEnabled } from './tool-definition'",
        "import { isChildRunCircuitBreakerEnabled } from './child-run-circuit-breaker'",
        'export function snapshotTurnFeatureFlags() {',
        '  return Object.freeze({',
        '    childResumeEnabled: isChildResumeEnabled(),',
        '    childInternalStrictAdmission: isChildInternalStrictAdmissionEnabled(),',
        '    childRunCircuitBreakerEnabled: isChildRunCircuitBreakerEnabled(undefined),',
        '  })',
        '}',
        '',
      ].join('\n'),
      'src/main/modules/agent-control/skills/skill-child-feature-flags.ts': [
        'export function isChildResumeEnabled() { return true }',
        '',
      ].join('\n'),
      'src/main/modules/agent-control/tools-runtime/tool-definition.ts': [
        'export function isChildInternalStrictAdmissionEnabled() { return true }',
        '',
      ].join('\n'),
      'src/main/modules/agent-control/child-run/child-run-circuit-breaker.ts': [
        'export function isChildRunCircuitBreakerEnabled() { return true }',
        '',
      ].join('\n'),
      'src/main/modules/tools/tool-executor.ts': [
        'export function executeToolCall(context) {',
        '  return context.turnFeatureFlags.childInternalStrictAdmission',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTurnFeatureFlags({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects a direct strict admission helper call in tool-executor', () => {
  withFixture(
    {
      'src/main/modules/agent-control/runtime-core/turn-feature-flags.ts': 'export {}\n',
      'src/main/modules/tools/tool-executor.ts': [
        "import { isChildInternalStrictAdmissionEnabled } from '../agent-control/tool-definition'",
        'export function executeToolCall() {',
        '  return isChildInternalStrictAdmissionEnabled()',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkTurnFeatureFlags({ root })
      assert.equal(result.violations.length, 2)
      assert.match(result.violations[0].message, /forbidden flag helper import/)
      assert.match(result.violations[1].message, /forbidden flag helper call/)
    },
  )
})

test('rejects a direct resume helper call in turn-engine body', () => {
  withFixture(
    {
      'src/main/modules/agent-control/runtime-core/turn-feature-flags.ts': 'export {}\n',
      'src/main/modules/agent-control/turn-engine.ts': [
        "import { isChildResumeEnabled } from './skill-child-feature-flags'",
        'export class TurnEngine {',
        '  async execute() {',
        '    return isChildResumeEnabled()',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/main/modules/tools/tool-executor.ts': 'export {}\n',
    },
    (root) => {
      const result = checkTurnFeatureFlags({ root })
      assert.equal(result.violations.length, 2)
      assert.match(result.violations[0].message, /forbidden flag helper import/)
      assert.match(result.violations[1].message, /forbidden flag helper call/)
    },
  )
})

test('supports CLI --root', () => {
  withFixture(
    {
      'src/main/modules/agent-control/runtime-core/turn-feature-flags.ts': 'export function snapshotTurnFeatureFlags() { return Object.freeze({}) }\n',
      'src/main/modules/tools/tool-executor.ts': 'export {}\n',
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /turn feature flags: ok/)
    },
  )
})
