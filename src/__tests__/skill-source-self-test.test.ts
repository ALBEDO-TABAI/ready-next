import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import type { FetchLike } from '../main/modules/skills-runtime/skill-source-registry'

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = scratch('ready-selftest-rt-')
  const embeddedRoot = scratch('ready-selftest-embedded-')
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, embeddedSkillsRoot: embeddedRoot, startBackgroundTasks: false }),
    cleanup: () => {
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(embeddedRoot, { recursive: true, force: true })
    },
  }
}

const shaFetch: FetchLike = async (url) => {
  if (url.includes('/commits')) {
    return new Response(JSON.stringify([{ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }]), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}

test('self-test probes both sources, resolves provenance, and proves staging — no real download', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const probed: string[] = []
    const probe = async (url: string): Promise<number | null> => {
      probed.push(url)
      return 42
    }

    const report = await manager.selfTestSkillSources(probe, shaFetch)

    assert.equal(report.probes.length, 2)
    assert.deepEqual(
      report.probes.map((p) => p.source).sort(),
      ['domestic', 'overseas'],
    )
    assert.ok(report.probes.every((p) => p.reachable && p.latencyMs === 42))
    assert.equal(report.anyReachable, true)
    // Both endpoints were actually probed (the 国内/国外 switch is exercised).
    assert.equal(probed.length, 2)

    assert.equal(report.refResolveOk, true)
    assert.match(report.refResolveDetail, /deadbeefdead/)

    assert.equal(report.stagingOk, true)
    assert.ok(report.startedAt)
    assert.ok(report.finishedAt)
  } finally {
    cleanup()
  }
})

test('an unreachable GitHub API yields refResolveOk=false but never aborts the report', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const failingFetch: FetchLike = async () => new Response('boom', { status: 503 })
    const probe = async (): Promise<number | null> => 17

    const report = await manager.selfTestSkillSources(probe, failingFetch)

    assert.equal(report.refResolveOk, false)
    assert.ok(report.refResolveDetail.length > 0)
    // Provenance failure must not poison the rest of the diagnostic.
    assert.equal(report.probes.length, 2)
    assert.equal(report.stagingOk, true)
  } finally {
    cleanup()
  }
})

test('a probe miss marks that source unreachable while anyReachable reflects the other', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const probe = async (url: string): Promise<number | null> =>
      url.includes('codeload.github.com') ? 88 : null

    const report = await manager.selfTestSkillSources(probe, shaFetch)

    const overseas = report.probes.find((p) => p.source === 'overseas')
    const domestic = report.probes.find((p) => p.source === 'domestic')
    assert.equal(overseas?.reachable, true)
    assert.equal(overseas?.latencyMs, 88)
    assert.equal(domestic?.reachable, false)
    assert.equal(domestic?.latencyMs, null)
    assert.equal(report.anyReachable, true)
  } finally {
    cleanup()
  }
})
