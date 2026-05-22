const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  checkSubagentIsolation,
} = require('../check-subagent-isolation.cjs')

test('check-subagent-isolation accepts relative sub-agent imports and explicit allowlist files', () => {
  const root = makeFixture()
  try {
    writeFile(root, 'src/main/modules/agent-control/task-projection/run-cleanup-registry.ts', 'export const cleanup = 1\n')
    writeFile(root, 'src/main/modules/agent-control/metrics.ts', 'export const metrics = 1\n')
    writeFile(root, 'src/main/modules/agent-control/tools-runtime/tool-error-metrics.ts', 'export const metrics = 1\n')
    writeFile(root, 'src/main/modules/agent-control/sub-agent/nested/util.ts', 'export const util = 1\n')
    writeFile(root, 'src/main/modules/agent-control/sub-agent/sub-agent-types.ts', [
      "import { readFileSync } from 'node:fs'",
      "import path from 'path'",
      "import { util } from './nested/util'",
      "import { cleanup } from '../task-projection/run-cleanup-registry'",
      "import { metrics } from '../metrics'",
      "export { metrics } from '../tools-runtime/tool-error-metrics'",
      "export {",
      '  util',
      "} from './nested/util'",
      "async function load() { return import(",
      "  './nested/util'",
      ') }',
      "const local = require('./nested/util')",
      'void readFileSync',
      'void path',
      'void cleanup',
      'void metrics',
      'void local',
      '',
    ].join('\n'))

    const result = checkSubagentIsolation({ root })

    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-subagent-isolation rejects child runner, turn engine, runtime manager, package, and sibling imports', () => {
  const root = makeFixture()
  try {
    writeFile(root, 'src/main/modules/agent-control/sub-agent/sub-agent-runner.ts', [
      "import { startSkillChildRun } from '../skill-child-runner'",
      "export { TurnEngine } from '../turn-engine'",
      "async function loadRuntime() { return import(",
      "  '../../skills-runtime/runtime-manager'",
      ') }',
      "const zod = require('zod')",
      "import childRunner = require('../skill-child-drivers')",
      "import '../run-coordinator'",
      'void startSkillChildRun',
      'void zod',
      'void childRunner',
      '',
    ].join('\n'))

    const result = checkSubagentIsolation({ root })

    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 6)
    assert.match(result.errors.join('\n'), /skill-child-runner/)
    assert.match(result.errors.join('\n'), /skill-child-drivers/)
    assert.match(result.errors.join('\n'), /turn-engine/)
    assert.match(result.errors.join('\n'), /runtime-manager/)
    assert.match(result.errors.join('\n'), /zod/)
    assert.match(result.errors.join('\n'), /run-coordinator/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-subagent-isolation skips cleanly when sub-agent directory is absent', () => {
  const root = makeFixture()
  try {
    const result = checkSubagentIsolation({ root })

    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  return mkdtempSync(join(tmpdir(), 'ready-subagent-isolation-'))
}

function writeFile(root, file, content) {
  const abs = join(root, file)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}
