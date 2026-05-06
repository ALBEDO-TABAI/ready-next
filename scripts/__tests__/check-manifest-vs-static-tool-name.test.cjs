'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  checkManifestVsStaticToolName,
} = require('../check-manifest-vs-static-tool-name.cjs')

function makeStaticFixture(entries) {
  const lines = entries.map(({ skillId, action, tool }) => `  '${skillId}:${action}': '${tool}',`)
  return [
    '/* fixture */',
    'export const STATIC_SKILL_TOOL_NAMES_BY_ACTION: Record<string, string> = {',
    ...lines,
    '}',
    '',
  ].join('\n')
}

function makeManifestFixture(rootDir, skillId, childLoopActions) {
  const dir = join(rootDir, skillId)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id: skillId,
    name: skillId,
    description: 'fixture',
    version: '0.0.1',
    actions: childLoopActions.map((a) => ({ name: a, type: 'shell', command: 'echo ok' })),
    child_loop: { version: 1, actions: childLoopActions },
  }
  writeFileSync(join(dir, 'ready-skill.json'), JSON.stringify(manifest, null, 2))
}

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'stage-n-gate-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('positive: real source passes', () => {
  const result = checkManifestVsStaticToolName()
  assert.equal(result.ok, true, `unexpected errors: ${result.errors.join('\n')}`)
})

test('negative: missing static-name entry for declared child_loop action', () => {
  withTempRoot((root) => {
    const staticFile = join(root, 'skills-tools-static.ts')
    writeFileSync(staticFile, makeStaticFixture([])) // empty static map
    const embeddedDir = join(root, 'embedded')
    makeManifestFixture(embeddedDir, 'fake-skill', ['phantom_action'])

    const result = checkManifestVsStaticToolName({ staticFile, embeddedDir })
    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /manifest action missing static tool name/,
    )
    assert.match(result.errors.join('\n'), /fake-skill:phantom_action/)
  })
})

test('negative: static entry refers to action not in manifest child_loop.actions[]', () => {
  withTempRoot((root) => {
    const staticFile = join(root, 'skills-tools-static.ts')
    writeFileSync(
      staticFile,
      makeStaticFixture([
        { skillId: 'fake-skill', action: 'declared_action', tool: 'skill_declared_action' },
        { skillId: 'fake-skill', action: 'extra_drift_action', tool: 'skill_extra_drift_action' },
      ]),
    )
    const embeddedDir = join(root, 'embedded')
    makeManifestFixture(embeddedDir, 'fake-skill', ['declared_action'])

    const result = checkManifestVsStaticToolName({ staticFile, embeddedDir })
    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /static tool action not declared in manifest/,
    )
    assert.match(result.errors.join('\n'), /fake-skill:extra_drift_action/)
  })
})

test('negative: both directions reported simultaneously', () => {
  withTempRoot((root) => {
    const staticFile = join(root, 'skills-tools-static.ts')
    writeFileSync(
      staticFile,
      makeStaticFixture([
        { skillId: 'fake-skill', action: 'stale_action', tool: 'skill_stale_action' },
      ]),
    )
    const embeddedDir = join(root, 'embedded')
    makeManifestFixture(embeddedDir, 'fake-skill', ['new_action'])

    const result = checkManifestVsStaticToolName({ staticFile, embeddedDir })
    assert.equal(result.ok, false)
    const blob = result.errors.join('\n')
    assert.match(blob, /manifest action missing static tool name/)
    assert.match(blob, /fake-skill:new_action/)
    assert.match(blob, /static tool action not declared in manifest/)
    assert.match(blob, /fake-skill:stale_action/)
  })
})

test('positive: skill with no child_loop is ignored', () => {
  withTempRoot((root) => {
    const staticFile = join(root, 'skills-tools-static.ts')
    writeFileSync(
      staticFile,
      makeStaticFixture([
        { skillId: 'no-loop-skill', action: 'a', tool: 'skill_a' },
      ]),
    )
    const embeddedDir = join(root, 'embedded')
    // No child_loop — manifest action 'a' is unrelated to the invariant.
    const dir = join(embeddedDir, 'no-loop-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'ready-skill.json'),
      JSON.stringify({
        id: 'no-loop-skill',
        name: 'no-loop-skill',
        description: 'fixture',
        version: '0.0.1',
        actions: [{ name: 'a', type: 'shell', command: 'echo ok' }],
      }, null, 2),
    )

    const result = checkManifestVsStaticToolName({ staticFile, embeddedDir })
    assert.equal(result.ok, true, `unexpected errors: ${result.errors.join('\n')}`)
  })
})
