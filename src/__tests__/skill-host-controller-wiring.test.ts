/**
 * B-arch-4 — verifies the SkillHostController is correctly wired into the
 * runtime + dispatch layer. Covers:
 *
 *   1. SkillsRuntimeManager.runSkill brackets runDefinitionActionDirect with
 *      prepareSpawnContext / restoreSpawnContext when the skill manifest
 *      declares host_requirements (and skips the wrap when it doesn't).
 *   2. executeRunShell honors an `effectiveAllowlist` computed by the
 *      controller's getEffectiveShellAllowlist so a session whose reference
 *      skill declares shell_allowlist_extensions can run a non-Phase-1 binary
 *      while the hint is armed (and other sessions still hit the rejection).
 *   3. SkillRunResult.status is populated from controller.detectStatus, so a
 *      'blocked' verdict surfaces even when exit_code === 0.
 *   4. Startup orphan cleanup invokes controller.cleanupSkillArtifacts for
 *      every retired-but-still-on-disk skill id (and only those — non-retired
 *      orphans are skipped with a log line).
 *
 * Wherever possible we drive the public surface (`runSkill`,
 * `executeSkillTool`, `cleanupOrphanedSkillArtifactsOnce`) to exercise the
 * full integration. The controller is a hand-rolled stub so we can assert
 * call ordering without touching the real agent-context source / file system
 * outside of explicit test fixtures.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillHostController,
  SpawnContextHandle,
} from '../main/modules/skills-runtime/skill-host-controller'
import type { SkillHostRequirements } from '../shared/skill-host-contract'
import { SHELL_ALLOWLIST, executeRunShell } from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

// ---------------------------------------------------------------------------
// Stub controller — records every call so tests can assert ordering /
// arguments. Does NOT touch disk. The shape mirrors the real controller's
// public surface; private methods are intentionally absent.
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'prepareSpawnContext' | 'restoreSpawnContext' | 'detectStatus' | 'cleanupSkillArtifacts' | 'getEffectiveShellAllowlist' | 'getEffectiveActionTimeout'
  args: unknown[]
  at: number
}

interface StubControllerOptions {
  detectStatusReturn?: { status: 'done' | 'error' | 'blocked'; detail?: string }
  shellAllowlistExtras?: string[]
  prepareSpawnContextDelay?: number
}

function makeStubController(options: StubControllerOptions = {}): {
  controller: SkillHostController
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const record = (method: RecordedCall['method'], args: unknown[]): void => {
    calls.push({ method, args, at: Date.now() })
  }
  const controller: SkillHostController = {
    async prepareSpawnContext(skillId, _skillName, _assetRoot, _requirements, jobId, outputDir): Promise<SpawnContextHandle> {
      record('prepareSpawnContext', [skillId, jobId, outputDir])
      if (options.prepareSpawnContextDelay) {
        await new Promise((res) => setTimeout(res, options.prepareSpawnContextDelay))
      }
      return {
        jobId,
        skillId,
        secondaryFilesCreated: [],
        envOverrides: undefined,
        releaseLock: () => {},
      }
    },
    async restoreSpawnContext(handle): Promise<void> {
      record('restoreSpawnContext', [handle.skillId, handle.jobId])
    },
    async detectStatus(_requirements, processResult, outputDir): Promise<{ status: 'done' | 'error' | 'blocked'; detail?: string }> {
      record('detectStatus', [processResult.exitCode, outputDir])
      return options.detectStatusReturn ?? { status: processResult.exitCode === 0 ? 'done' : 'error' }
    },
    async cleanupSkillArtifacts(skillId, skillName, _assetRoot, _requirements): Promise<{ removedPaths: string[]; errors: Array<{ path: string; error: string }> }> {
      record('cleanupSkillArtifacts', [skillId, skillName])
      return { removedPaths: [], errors: [] }
    },
    getEffectiveShellAllowlist(sessionId, referenceSkillId, baseAllowlist, _requirements): Set<string> {
      record('getEffectiveShellAllowlist', [sessionId, referenceSkillId])
      const merged = new Set<string>(baseAllowlist)
      if (sessionId && referenceSkillId && options.shellAllowlistExtras) {
        for (const cmd of options.shellAllowlistExtras) merged.add(cmd)
      }
      return merged
    },
    getEffectiveActionTimeout(_requirements, actionTimeoutMs, fallbackDefault): number {
      record('getEffectiveActionTimeout', [actionTimeoutMs, fallbackDefault])
      return actionTimeoutMs ?? fallbackDefault
    },
  } as unknown as SkillHostController
  return { controller, calls }
}

// ---------------------------------------------------------------------------
// Fixture: a custom skill whose only action is reference (so we don't need a
// Python venv) AND that declares host_requirements (so the spawn-context wrap
// is exercised).
// ---------------------------------------------------------------------------

interface SkillFixtureOptions {
  withHostRequirements: boolean
  spawnContext?: boolean
  outputDirParam?: boolean
}

function makeCustomSkillFixture(options: SkillFixtureOptions): {
  runtimeRoot: string
  embeddedSkillsRoot: string
  skillId: string
  cleanup: () => void
} {
  const tempRoot = mkdtempSync(join(tmpdir(), 'skill-wiring-fixture-'))
  const embeddedSkillsRoot = join(tempRoot, 'embedded-skills')
  const runtimeRoot = join(tempRoot, 'runtime')
  const skillId = `wiring-fixture-${Date.now()}`
  const customSkillsRoot = join(runtimeRoot, 'custom-skills')
  const managedPath = join(customSkillsRoot, skillId)

  mkdirSync(embeddedSkillsRoot, { recursive: true })
  mkdirSync(managedPath, { recursive: true })

  const manifest: Record<string, unknown> = {
    id: skillId,
    name: 'Wiring Fixture Skill',
    description: 'wiring fixture',
    version: '1.0.0',
    source: 'custom',
    runtime: 'reference',
    defaultAction: 'read_skill',
    sourcePath: managedPath,
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actions: [
      {
        name: 'read_skill',
        runtime: 'reference',
        entry: 'SKILL.md',
        visibility: 'internal',
        inputMode: options.outputDirParam ? 'json' : undefined,
        params: options.outputDirParam
          ? [{ name: 'outputDir', type: 'string', required: false }]
          : [],
      },
    ],
    execution: { mode: 'advisory' },
  }

  if (options.withHostRequirements) {
    // A minimal host_requirements that the controller stub will see; we don't
    // exercise actual file writes (the stub doesn't touch disk).
    manifest.host_requirements = {
      manifest_version: 1,
      shell_allowlist_extensions: ['ffmpeg'],
      default_action_timeout_ms: 90_000,
      ...(options.spawnContext === false
        ? {}
        : {
            spawn_context: {
              env: {
                WIRING_FIXTURE_OUTPUT_DIR: '${output_dir}',
              },
            },
          }),
    } satisfies SkillHostRequirements
  }

  writeFileSync(join(managedPath, 'ready-skill.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(managedPath, 'SKILL.md'), '# Wiring fixture\n\nadvisory skill content', 'utf8')

  return {
    runtimeRoot,
    embeddedSkillsRoot,
    skillId,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// 1. runSkill brackets runDefinitionActionDirect with prepare → restore
// ---------------------------------------------------------------------------

test('runSkill wraps runDefinitionActionDirect with prepareSpawnContext → restoreSpawnContext when host_requirements is declared', async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: true })
  try {
    const { controller, calls } = makeStubController({ prepareSpawnContextDelay: 10 })
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true, `expected success, got error="${result.error}"`)
    assert.equal(result.mode, 'reference')

    const ordered = calls.map((c) => c.method)
    const prepareIdx = ordered.indexOf('prepareSpawnContext')
    const detectIdx = ordered.indexOf('detectStatus')
    const restoreIdx = ordered.indexOf('restoreSpawnContext')
    assert.ok(prepareIdx >= 0, `prepareSpawnContext should be called, got ${JSON.stringify(ordered)}`)
    assert.ok(detectIdx > prepareIdx, `detectStatus must run AFTER prepareSpawnContext, got ${JSON.stringify(ordered)}`)
    assert.ok(restoreIdx > detectIdx, `restoreSpawnContext must run AFTER detectStatus (i.e. after the action), got ${JSON.stringify(ordered)}`)
  } finally {
    fx.cleanup()
  }
})

test('runSkill SKIPS prepare/restore when manifest does NOT declare host_requirements', async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: false })
  try {
    const { controller, calls } = makeStubController()
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true)
    const methods = calls.map((c) => c.method)
    assert.equal(methods.includes('prepareSpawnContext'), false, 'prepareSpawnContext should NOT be called without host_requirements')
    assert.equal(methods.includes('restoreSpawnContext'), false, 'restoreSpawnContext should NOT be called without host_requirements')
    // detectStatus is still called (used to backfill SkillRunResult.status).
    assert.equal(methods.includes('detectStatus'), true)
  } finally {
    fx.cleanup()
  }
})

test('runSkill prepares outputDir for json actions without requiring a spawn context', async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: false, outputDirParam: true })
  try {
    const { controller, calls } = makeStubController()
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true)
    assert.match(String(result.outputDir), new RegExp(`/outputs/${fx.skillId}/[0-9a-f-]{36}$`))
    const methods = calls.map((c) => c.method)
    assert.equal(methods.includes('prepareSpawnContext'), false, 'outputDir creation must not require spawn preparation')
    assert.equal(methods.includes('restoreSpawnContext'), false, 'outputDir creation must not require spawn restoration')
  } finally {
    fx.cleanup()
  }
})

test('runSkill uses timeout-only host_requirements without preparing spawn context', async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: true, spawnContext: false })
  try {
    const { controller, calls } = makeStubController()
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true)
    const methods = calls.map((c) => c.method)
    assert.equal(methods.includes('getEffectiveActionTimeout'), true)
    assert.equal(methods.includes('detectStatus'), true)
    assert.equal(methods.includes('prepareSpawnContext'), false)
    assert.equal(methods.includes('restoreSpawnContext'), false)
  } finally {
    fx.cleanup()
  }
})

test('runSkill passes a stable outputDir into host spawn context when host_requirements is declared', async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: true })
  try {
    const { controller, calls } = makeStubController()
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true)
    const prepare = calls.find((call) => call.method === 'prepareSpawnContext')
    assert.ok(prepare, 'prepareSpawnContext should be called')
    assert.equal(typeof prepare.args[2], 'string')
    assert.match(String(prepare.args[2]), new RegExp(`/outputs/${fx.skillId}/[0-9a-f-]{36}$`))
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 2. detectStatus → SkillRunResult.status propagation (blocked verdict)
// ---------------------------------------------------------------------------

test("SkillRunResult.status === 'blocked' when controller.detectStatus returns blocked, even on exit 0", async () => {
  const fx = makeCustomSkillFixture({ withHostRequirements: true })
  try {
    const { controller } = makeStubController({
      detectStatusReturn: { status: 'blocked', detail: 'awaiting_input' },
    })
    const manager = new SkillsRuntimeManager({
      runtimeRoot: fx.runtimeRoot,
      embeddedSkillsRoot: fx.embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
    })

    const result = await manager.runSkill({
      skillId: fx.skillId,
      action: 'read_skill',
      params: {},
    })

    assert.equal(result.success, true, 'reference action itself succeeded')
    assert.equal(result.status, 'blocked', `expected status='blocked', got '${result.status}'`)
  } finally {
    fx.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 3. executeRunShell honors effectiveAllowlist from getEffectiveShellAllowlist
// ---------------------------------------------------------------------------

test('executeRunShell ACCEPTS a non-Phase-1 binary when an effectiveAllowlist that includes it is passed', async () => {
  // We set up a fake spawn that just resolves so we don't actually exec ffmpeg.
  const artifactRoot = mkdtempSync(join(tmpdir(), 'wiring-art-'))
  const assetRoot = mkdtempSync(join(tmpdir(), 'wiring-asset-'))
  try {
    const lookup = (id: string): SkillRootSet | null =>
      id === 'fixture-skill' ? { skillId: 'fixture-skill', assetRoot, artifactRoot } : null

    const fakeSpawn = ((_bin: string, _args: string[], _options: Record<string, unknown>) => {
      let closeCb: ((code: number) => void) | null = null
      return {
        pid: 1,
        killed: false,
        stdin: { write: () => {}, end: () => {} },
        stdout: { setEncoding: () => {}, on: () => {} },
        stderr: { setEncoding: () => {}, on: () => {} },
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') {
            closeCb = cb
            setImmediate(() => closeCb?.(0))
          }
        },
        kill: () => {},
      }
    }) as unknown as typeof import('node:child_process').spawn

    // Without the override, ffmpeg should be rejected (it IS in SHELL_ALLOWLIST
    // actually — pick a known-not-in-list binary like 'imagemagick' for the
    // contrast). But for the positive case, simulate a controller that adds
    // 'imagemagick' via shell_allowlist_extensions when a hint is armed.
    const baseAllowlist = SHELL_ALLOWLIST
    assert.equal(baseAllowlist.has('imagemagick'), false, 'sanity: imagemagick not in base allowlist')
    const extended = new Set<string>(baseAllowlist)
    extended.add('imagemagick')

    // Negative: without the extended allowlist, imagemagick is rejected.
    await assert.rejects(
      executeRunShell(
        { command: 'imagemagick --version' },
        { skillId: 'fixture-skill', lookupSkillRoots: lookup, spawnFn: fakeSpawn },
      ),
      (err: unknown) => (err as { errorKind?: string })?.errorKind === 'cmd_not_allowlisted',
    )

    // Positive: with the extended allowlist, the call succeeds.
    const out = await executeRunShell(
      { command: 'imagemagick --version' },
      {
        skillId: 'fixture-skill',
        lookupSkillRoots: lookup,
        spawnFn: fakeSpawn,
        effectiveAllowlist: extended,
      },
    )
    const data = out.data as Record<string, unknown>
    assert.equal(data.exitCode, 0)
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true })
    rmSync(assetRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Startup orphan cleanup invokes cleanupSkillArtifacts for retired ids
// ---------------------------------------------------------------------------

test('cleanupOrphanedSkillArtifactsOnce calls controller.cleanupSkillArtifacts for orphan dirs whose id is in the retired allowlist', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wiring-orphan-'))
  const runtimeRoot = join(tempRoot, 'runtime')
  const embeddedSkillsRoot = join(tempRoot, 'embedded-skills')
  const skillsDir = join(runtimeRoot, 'skills')
  try {
    mkdirSync(embeddedSkillsRoot, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
    // Three sub-folders:
    //  - 'wiring-retired-id'    → in retired allowlist → should be cleaned
    //  - 'wiring-unknown-id'    → not in EMBEDDED, not in custom registry,
    //                             not in retired allowlist → SKIPPED (logged)
    //  - 'video-expert-analyzer' → embedded id → SKIPPED
    mkdirSync(join(skillsDir, 'wiring-retired-id'))
    mkdirSync(join(skillsDir, 'wiring-unknown-id'))
    mkdirSync(join(skillsDir, 'video-expert-analyzer'))

    const { controller, calls } = makeStubController()
    const manager = new SkillsRuntimeManager({
      runtimeRoot,
      embeddedSkillsRoot,
      startBackgroundTasks: false,
      hostController: controller,
      retiredEmbeddedSkillIds: new Set(['wiring-retired-id']),
    })

    await manager.cleanupOrphanedSkillArtifactsOnce()

    const cleanupCalls = calls.filter((c) => c.method === 'cleanupSkillArtifacts')
    assert.equal(cleanupCalls.length, 1, `expected exactly one cleanupSkillArtifacts call, got ${cleanupCalls.length} (${JSON.stringify(cleanupCalls)})`)
    assert.equal(cleanupCalls[0].args[0], 'wiring-retired-id')

    // Idempotency: a second call must NOT re-trigger the cleanup.
    const before = cleanupCalls.length
    await manager.cleanupOrphanedSkillArtifactsOnce()
    const after = calls.filter((c) => c.method === 'cleanupSkillArtifacts').length
    assert.equal(after, before, 'cleanupOrphanedSkillArtifactsOnce must be idempotent')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
