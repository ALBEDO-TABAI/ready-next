'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  checkNoParentForceForChildLoop,
  checkDefaultResumeTable,
  checkSynthesisFence,
  checkGuardWriteBelt,
} = require('../check-no-parent-force-for-child-loop.cjs')

const REPO = join(__dirname, '..', '..')

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'stage-n-no-force-gate-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('positive: real source passes the combined gate', () => {
  const result = checkNoParentForceForChildLoop()
  assert.equal(result.ok, true, `unexpected errors: ${result.errors.join('\n')}`)
})

test('negative #1: VEA in DEFAULT_RESUME_ACTION_BY_SKILL_ID fails', () => {
  withTempRoot((root) => {
    const steeringFile = join(root, 'turn-frame-steering.ts')
    writeFileSync(
      steeringFile,
      [
        '// fixture',
        'const DEFAULT_RESUME_ACTION_BY_SKILL_ID: Record<string, string> = {',
        '  "video-expert-analyzer": "video_expert_pipeline",',
        '}',
        '',
      ].join('\n'),
    )
    const embeddedDir = join(root, 'embedded')
    mkdirSync(join(embeddedDir, 'video-expert-analyzer'), { recursive: true })
    writeFileSync(
      join(embeddedDir, 'video-expert-analyzer', 'ready-skill.json'),
      JSON.stringify({
        id: 'video-expert-analyzer',
        name: 'VEA',
        description: 'fixture',
        version: '0.0.1',
        actions: [],
        child_loop: { version: 1, actions: ['video_expert_pipeline'] },
      }),
    )

    // Use the real turn-engine.ts so checks #2/#3 don't false-fail; only #1
    // should report the violation.
    const childActions = new Map([['video-expert-analyzer', new Set(['video_expert_pipeline'])]])
    const r = checkDefaultResumeTable(steeringFile, childActions)
    assert.equal(r.ok, false)
    assert.match(r.reason, /child-loop action in default-resume table/)
    assert.match(r.reason, /video-expert-analyzer:video_expert_pipeline/)
  })
})

test('negative #2: synthesis fence missing manifest predicate fails', () => {
  withTempRoot((root) => {
    const turnEngineFile = join(root, 'turn-engine.ts')
    writeFileSync(
      turnEngineFile,
      [
        '// fixture',
        'function loop() {',
        '  const childOwnedByContract = !shouldParentForceLongSkillTool(contract)',
        '  // legacy fixture without manifest predicate reference',
        '  const forceToolName = childOwnedByContract ? null : "x"',
        '}',
        '',
      ].join('\n'),
    )
    const r = checkSynthesisFence(turnEngineFile)
    assert.equal(r.ok, false)
    assert.match(r.reason, /isParentForceForbiddenByManifest/)
  })
})

test('negative #2 alt: synthesis fence missing contract predicate fails', () => {
  withTempRoot((root) => {
    const turnEngineFile = join(root, 'turn-engine.ts')
    writeFileSync(
      turnEngineFile,
      [
        '// fixture',
        'function loop() {',
        '  const childOwnedByContract = isParentForceForbiddenByManifest("x")',
        '  // legacy fixture without contract predicate reference',
        '  const forceToolName = childOwnedByContract ? null : "x"',
        '}',
        '',
      ].join('\n'),
    )
    const r = checkSynthesisFence(turnEngineFile)
    assert.equal(r.ok, false)
    assert.match(r.reason, /shouldParentForceLongSkillTool/)
  })
})

test('negative #3: guardPatch write site missing invariant belt fails', () => {
  withTempRoot((root) => {
    const turnEngineFile = join(root, 'turn-engine.ts')
    const filler = Array(120).fill('  // unrelated line').join('\n')
    writeFileSync(
      turnEngineFile,
      [
        '// fixture',
        filler,
        '  if (turnFrame && turnFrame.skill) {',
        '    const guardPatch: TurnFramePatch = {',
        '      runContract: { skillId: "x" },',
        '    }',
        '  }',
        '',
      ].join('\n'),
    )
    const r = checkGuardWriteBelt(turnEngineFile)
    assert.equal(r.ok, false)
    assert.match(r.reason, /isParentForceForbiddenByManifest/)
  })
})

test('positive #3: real turn-engine.ts has the belt', () => {
  const r = checkGuardWriteBelt(join(REPO, 'src/main/modules/agent-control/turn-engine.ts'))
  assert.equal(r.ok, true, `expected belt to be present: ${r.reason || ''}`)
})
