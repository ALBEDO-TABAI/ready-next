import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeRunShell } from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

export const C04_DYNAMIC_WRITE_KNOWN_GAP = true

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-c04-art-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-c04-asset-')))
  const externalRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-shell-c04-external-')))
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

test('C04_DYNAMIC_WRITE_KNOWN_GAP — sentinel declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-run-shell-c04-known-gap transitive sqlite load')
})

test('KNOWN GAP (C04 partially-open): node dynamic absolute writes still escape without OS isolation', async () => {
  const fx = makeFixture()
  try {
    const nodeSentinel = join(fx.externalRoot, 'node-dynamic.txt')
    await executeRunShell(
      { command: `node -e "require('fs').writeFileSync('${nodeSentinel}','x')"` },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    // This green means C04 is still open. Only P2b OS-level isolation can close it.
    assert.equal(existsSync(nodeSentinel), true)
  } finally {
    fx.cleanup()
  }
})

test('KNOWN GAP (C04 partially-open): python dynamic absolute writes still escape without OS isolation', async () => {
  const fx = makeFixture()
  try {
    const pythonSentinel = join(fx.externalRoot, 'python-dynamic.txt')
    await executeRunShell(
      { command: `python3 -c "open('${pythonSentinel}','w').write('x')"` },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    // This green means C04 is still open. Only P2b OS-level isolation can close it.
    assert.equal(existsSync(pythonSentinel), true)
  } finally {
    fx.cleanup()
  }
})
