const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkChildStatusVocabulary,
} = require('../check-child-status-vocabulary.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-child-status-vocabulary.cjs')

// File-name → relative subdir mapping that mirrors the real Stage U module
// reshuffle. The script under test scans agent-control/ recursively, so
// fixtures must land at the same locations the production tree uses.
const FIXTURE_SUBDIR_BY_FILE = {
  'skill-child-run-types.ts': 'skills',
  'skill-child-sub-agent.ts': 'skills',
  'skill-child-runner.ts': 'skills',
  'turn-frame-steering.ts': 'runtime-core',
  'child-run-circuit-breaker.ts': 'child-run',
}

function withAgentControlFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-child-status-vocab-'))
  try {
    const agentControlDir = join(root, 'src/main/modules/agent-control')
    mkdirSync(agentControlDir, { recursive: true })
    for (const [relativePath, source] of Object.entries(files)) {
      const subdir = FIXTURE_SUBDIR_BY_FILE[relativePath]
      const targetDir = subdir ? join(agentControlDir, subdir) : agentControlDir
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, relativePath), source)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts helper usage outside skill-child-run-types', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        'export function isTerminalChildCloseStatus(status: string): boolean {',
        '  return TERMINAL_CHILD_CLOSE_STATUSES.has(status)',
        '}',
        '',
      ].join('\n'),
      'turn-engine.ts': [
        "import { isTerminalChildCloseStatus } from './skill-child-run-types'",
        'export function decide(live: { status: string }): boolean {',
        '  return isTerminalChildCloseStatus(live.status)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects duplicate terminal close status set outside skill-child-run-types', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-frame-steering.ts': [
        "const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.equal(result.violations.length, 1)
      assert.match(result.violations[0].message, /duplicate TERMINAL_CHILD_CLOSE_STATUSES/)
      assert.equal(result.violations[0].file, 'src/main/modules/agent-control/runtime-core/turn-frame-steering.ts')
    },
  )
})

test('rejects forbidden close status literal decisions', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'child-run-circuit-breaker.ts': [
        'export function shouldCount(close: { status: string }): boolean {',
        "  return close.status === 'failed'",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.equal(result.violations.length, 1)
      assert.match(result.violations[0].message, /forbidden status literal decision/)
      assert.equal(result.violations[0].line, 2)
    },
  )
})

test('accepts explicit W0 whitelist status mappings', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-engine.ts': [
        'export function renderChildCommandOutcome(close: { status: string }): string {',
        '  switch (close.status) {',
        "    case 'completed': return 'done'",
        "    case 'failed': return 'error'",
        "    case 'killed': return 'cancelled'",
        "    default: return 'paused'",
        '  }',
        '}',
        'export function routeTerminal(childStatus: string): string {',
        '  const turnTerminalReason =',
        "    childStatus === 'completed' ? 'done'",
        "    : childStatus === 'failed' ? 'failed_skill'",
        "    : childStatus === 'killed' ? 'cancelled_user'",
        "    : 'done'",
        '  return turnTerminalReason',
        '}',
        '',
      ].join('\n'),
      'skill-child-sub-agent.ts': [
        'export function subAgentReasonForChildClose(closeEvent: { status: string }): string {',
        "  return closeEvent.status === 'failed' ? 'failed_skill' : 'completed'",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('supports CLI --root', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-engine.ts': [
        "import { isTerminalChildCloseStatus } from './skill-child-run-types'",
        'export function decide(live: { status: string }): boolean {',
        '  return isTerminalChildCloseStatus(live.status)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /child status vocabulary: ok/)
    },
  )
})

test('rejects manual childCloseEvent assignment in resume branch', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-engine.ts': [
        'export async function execute(contract: { childCloseEvent: unknown }, resumed: { closeEvent: unknown }) {',
        '  const isSkillResumeTurnDetected = true',
        '  if (isSkillResumeTurnDetected) {',
        '    contract.childCloseEvent = resumed.closeEvent',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.equal(result.violations.length, 1)
      assert.match(result.violations[0].message, /forbidden resume childCloseEvent assignment/)
      assert.equal(result.violations[0].line, 4)
    },
  )
})

test('accepts Object.assign with freshContractFields in resume branch', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-engine.ts': [
        'export async function execute(contract: object, resumed: { freshContractFields: object | null }) {',
        '  const isSkillResumeTurnDetected = true',
        '  if (isSkillResumeTurnDetected && resumed.freshContractFields) {',
        '    Object.assign(contract, resumed.freshContractFields)',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('accepts non-resume childCloseEvent null reset', () => {
  withAgentControlFixture(
    {
      'skill-child-run-types.ts': [
        "export const TERMINAL_CHILD_CLOSE_STATUSES = new Set(['completed', 'failed', 'killed'])",
        '',
      ].join('\n'),
      'turn-engine.ts': [
        'export function reset(contract: { childCloseEvent: unknown }) {',
        '  contract.childCloseEvent = null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkChildStatusVocabulary({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})
