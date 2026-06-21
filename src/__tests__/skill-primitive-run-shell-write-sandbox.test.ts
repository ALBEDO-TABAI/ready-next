import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeRunShell } from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-primitive-run-shell-write-sandbox declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-primitive-run-shell-write-sandbox transitive sqlite load')
})

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-sandbox-art-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-sandbox-asset-')))
  const externalRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-sandbox-external-')))
  const lookup = (id: string): SkillRootSet | null =>
    id === 'test-skill' ? { skillId: 'test-skill', assetRoot, artifactRoot } : null
  return {
    artifactRoot,
    assetRoot,
    externalRoot,
    lookup,
    cleanup: () => {
      rmSync(artifactRoot, { recursive: true, force: true })
      rmSync(assetRoot, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    },
  }
}

test('skill_run_shell cwd writes to artifactRoot, not read-only assetRoot', async () => {
  const fx = makeFixture()
  try {
    await executeRunShell(
      { command: 'bash -c "echo asset-write > pwn.txt"' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )

    assert.equal(existsSync(join(fx.assetRoot, 'pwn.txt')), false)
    assert.equal(existsSync(join(fx.artifactRoot, 'pwn.txt')), true)
  } finally {
    fx.cleanup()
  }
})

test('skill_run_shell rejects explicit absolute redirection outside artifactRoot', async () => {
  const fx = makeFixture()
  try {
    const externalSentinel = join(fx.externalRoot, 'outside.txt')
    await assert.rejects(
      executeRunShell(
        { command: `bash -c "echo outside-write > ${externalSentinel}"` },
        { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
      ),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'write_outside_sandbox',
    )
    assert.equal(existsSync(externalSentinel), false)
  } finally {
    fx.cleanup()
  }
})

test('skill_run_shell still allows explicit absolute redirection inside artifactRoot', async () => {
  const fx = makeFixture()
  try {
    const insideSentinel = join(fx.artifactRoot, 'inside.txt')
    await executeRunShell(
      { command: `bash -c "echo inside-write > ${insideSentinel}"` },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    assert.equal(existsSync(insideSentinel), true)
  } finally {
    fx.cleanup()
  }
})
