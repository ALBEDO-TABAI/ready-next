const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  collectSkillChildRunnerApi,
} = require('../check-skill-child-runner-api.cjs')

test('skill child runner API snapshot ignores internal test invariant markers', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-skill-child-api-'))
  try {
    mkdirSync(join(root, 'src/main/modules/agent-control/skills'), { recursive: true })
    writeFileSync(
      join(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts'),
      [
        "export const __breaksInvariants = ['singleton.reset'] as const",
        'export const __noProductionInvariantBreach = true',
        "export const publicConstant = 'kept'",
        'export function publicFunction() { return true }',
        '',
      ].join('\n'),
    )

    const actual = collectSkillChildRunnerApi({
      root,
      source: 'src/main/modules/agent-control/skills/skill-child-runner.ts',
    })

    assert.deepEqual(
      actual.exports.map((entry) => entry.name),
      ['publicConstant', 'publicFunction'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
