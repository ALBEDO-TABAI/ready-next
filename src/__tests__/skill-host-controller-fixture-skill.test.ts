/**
 * Architectural proof — exercises the entire Skill Host Contract surface
 * against a single fixture skill (src/__tests__/fixtures/embedded-skills/
 * test-host-contract/) and asserts that no Ready source file mentions the
 * fixture skill by name.
 *
 * If this test passes, a future skill author can ship a brand new skill by
 * dropping a folder + manifest + script into the embedded-skills root with
 * ZERO changes to Ready code. That's the entire promise of the Skill Host
 * Contract layer.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  SkillHostController,
} from '../main/modules/skills-runtime/skill-host-controller'
import type { AgentSpawnContext } from '../shared/skill-host-contract'

// ---------------------------------------------------------------------------
// Fixture location
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE_DIR = resolve(
  __dirname,
  'fixtures',
  'embedded-skills',
  'test-host-contract',
)
const REPO_ROOT = resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(): AgentSpawnContext {
  return {
    provider: 'kimi',
    model_id: 'kimi-k2',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-test-DO-NOT-LEAK',
    api_kind: 'anthropic-messages', // B-arch-6: derived API style; proves ${agent.api_kind} works
    fallback_chain: [],
  }
}

function makeController(): SkillHostController {
  return new SkillHostController({
    readAgentContext: async () => makeAgent(),
    warn: () => {},
  })
}

/**
 * Run `body` with process.env.HOME (and USERPROFILE on Windows) pointed at
 * `homeOverride` so paths templated as `${env.HOME}/...` resolve into a
 * disposable scratch tree AND `os.homedir()` returns the same root (the
 * controller's path-guard accepts paths under HOME / tmpdir / XDG).
 */
async function withScratchHome(
  homeOverride: string,
  body: () => Promise<void> | void,
): Promise<void> {
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  try {
    process.env.HOME = homeOverride
    process.env.USERPROFILE = homeOverride
    await body()
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
  }
}

// ---------------------------------------------------------------------------
// 1. Manifest validation — host_requirements is parsed exactly as declared
// ---------------------------------------------------------------------------

test('fixture: skill compiler accepts the manifest and parses host_requirements with the custom state field', () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })

  assert.equal(definition.id, 'test-host-contract')
  assert.equal(definition.name, 'Test Host Contract Fixture')
  assert.equal(definition.defaultAction, 'echo')

  const host = definition.hostRequirements
  assert.ok(host, 'hostRequirements must be parsed off the manifest')
  if (!host) return

  // spawn_context.config_file
  assert.equal(host.spawn_context?.config_file?.format, 'json')
  assert.equal(
    Object.keys(host.spawn_context?.config_file?.fields ?? {}).length,
    2,
    'config_file must declare exactly two fields',
  )
  assert.equal(
    host.spawn_context?.config_file?.fields['/runtime/preferred_model'],
    '${agent.model_id}',
  )
  assert.equal(
    host.spawn_context?.config_file?.fields['/runtime/provider'],
    '${agent.provider}',
  )
  // preserve_existing default lands true.
  assert.equal(host.spawn_context?.config_file?.preserve_existing, true)

  // spawn_context.secondary_files
  assert.equal(host.spawn_context?.secondary_files?.length, 1)

  // shell_allowlist_extensions = ['pandoc']
  assert.deepEqual(host.shell_allowlist_extensions, ['pandoc'])

  // default_action_timeout_ms = 600_000
  assert.equal(host.default_action_timeout_ms, 600_000)

  // status_detection — note the CUSTOM 'state' field name.
  assert.equal(host.status_detection?.method, 'sentinel_file')
  assert.equal(host.status_detection?.file_path, '${output_dir}/state.json')
  assert.equal(
    host.status_detection?.json_field,
    'state',
    'controller must read the manifest-declared field name, not a hardcoded "status"',
  )
  assert.deepEqual(host.status_detection?.blocked_values, ['needs_review'])

  // lifecycle.on_uninstall_remove
  assert.deepEqual(host.lifecycle?.on_uninstall_remove, [
    '${env.HOME}/.config/test-host-contract',
  ])
})

// ---------------------------------------------------------------------------
// 2. prepareSpawnContext writes config + secondary, all template variables resolved
// ---------------------------------------------------------------------------

test('fixture: prepareSpawnContext materializes config + secondary files with all template variables resolved', async () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const controller = makeController()
  const handle = await controller.prepareSpawnContext(
    definition.id,
    definition.name,
    FIXTURE_DIR,
    definition.hostRequirements ?? null,
    'job-architectural-proof',
  )
  try {
    // The config_file path used `${spawn.tmp_dir}/...`. The handle records the
    // RESOLVED absolute path, so we read directly from there.
    const cfgPath = handle.configFileBackup?.path
    assert.ok(cfgPath, 'config file path must be recorded on the handle')
    if (!cfgPath) return
    assert.ok(existsSync(cfgPath), `config file should exist at ${cfgPath}`)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    const runtime = cfg.runtime as Record<string, unknown>
    assert.equal(runtime.preferred_model, 'kimi-k2', '${agent.model_id} must resolve')
    assert.equal(runtime.provider, 'kimi', '${agent.provider} must resolve')

    // Secondary file
    assert.equal(handle.secondaryFilesCreated.length, 1)
    const secPath = handle.secondaryFilesCreated[0]
    assert.ok(existsSync(secPath), `secondary file should exist at ${secPath}`)
    const sec = readFileSync(secPath, 'utf8')
    // Template was:
    //   "skill=${skill.id} job=${spawn.job_id} model=${agent.model_id} api=${agent.api_kind}"
    // The api=... segment is the architectural proof that the B-arch-6 derived
    // variable threads end-to-end into spawn-context templates.
    assert.match(
      sec,
      /^skill=test-host-contract job=[0-9a-f]{8} model=kimi-k2 api=anthropic-messages$/,
      `secondary file content unexpected: ${JSON.stringify(sec)}`,
    )
  } finally {
    await controller.restoreSpawnContext(handle)
  }
})

// ---------------------------------------------------------------------------
// 3. detectStatus reads the manifest-declared json_field name (`state`),
//    not a hardcoded one. Maps blocked / done correctly.
// ---------------------------------------------------------------------------

test('fixture: detectStatus honors the manifest-declared json_field name "state" and blocked_values', async () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const controller = makeController()
  const outputDir = mkdtempSync(join(tmpdir(), 'fixture-output-'))
  try {
    const sentinel = join(outputDir, 'state.json')

    // (a) Sentinel says state=done → status=done
    writeFileSync(sentinel, JSON.stringify({ state: 'done', detail: 'ok' }))
    const done = await controller.detectStatus(
      definition.hostRequirements ?? null,
      { exitCode: 0, stdout: '', stderr: '' },
      outputDir,
    )
    assert.equal(done.status, 'done')

    // (b) Sentinel says state=needs_review → status=blocked (custom blocked_values)
    writeFileSync(sentinel, JSON.stringify({ state: 'needs_review' }))
    const blocked = await controller.detectStatus(
      definition.hostRequirements ?? null,
      { exitCode: 0, stdout: '', stderr: '' },
      outputDir,
    )
    assert.equal(
      blocked.status,
      'blocked',
      'manifest-declared blocked_values=["needs_review"] must be honored',
    )

    // (c) Different field name (status, not state) → controller IGNORES it,
    //     because the manifest pinned the field to 'state'. Without 'state',
    //     value is undefined → falls back to done on exit_code 0.
    writeFileSync(sentinel, JSON.stringify({ status: 'needs_review' }))
    const ignored = await controller.detectStatus(
      definition.hostRequirements ?? null,
      { exitCode: 0, stdout: '', stderr: '' },
      outputDir,
    )
    assert.equal(
      ignored.status,
      'done',
      'controller must read the manifest field name, not hardcoded "status"',
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. getEffectiveShellAllowlist merges 'pandoc' when the hint is armed
// ---------------------------------------------------------------------------

test('fixture: getEffectiveShellAllowlist exposes pandoc only when sessionId+hint match this skill', () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const controller = makeController()
  // Base allowlist intentionally does NOT include pandoc — proves the fixture
  // is exercising the extension path.
  const base: ReadonlySet<string> = new Set(['python', 'bash'])
  assert.equal(base.has('pandoc'), false)

  // Without a session id: extensions are NOT merged.
  const noSession = controller.getEffectiveShellAllowlist(
    undefined,
    definition.id,
    base,
    definition.hostRequirements ?? null,
  )
  assert.equal(noSession.has('pandoc'), false)

  // With session id but no hint id: extensions are NOT merged.
  const noHint = controller.getEffectiveShellAllowlist(
    'sess-1',
    null,
    base,
    definition.hostRequirements ?? null,
  )
  assert.equal(noHint.has('pandoc'), false)

  // Session + hint → pandoc IS merged.
  const armed = controller.getEffectiveShellAllowlist(
    'sess-1',
    definition.id,
    base,
    definition.hostRequirements ?? null,
  )
  assert.equal(armed.has('pandoc'), true, 'pandoc must be exposed when the hint is armed')
  assert.equal(armed.has('python'), true, 'base entries must survive the merge')
})

// ---------------------------------------------------------------------------
// 5. getEffectiveActionTimeout returns 600_000 from manifest when no override
// ---------------------------------------------------------------------------

test('fixture: getEffectiveActionTimeout returns the manifest default (600_000) when no per-action override is given', () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const controller = makeController()
  // No action-level override → manifest wins.
  assert.equal(
    controller.getEffectiveActionTimeout(
      definition.hostRequirements ?? null,
      undefined,
      30_000,
    ),
    600_000,
  )
  // Action-level override beats manifest.
  assert.equal(
    controller.getEffectiveActionTimeout(
      definition.hostRequirements ?? null,
      45_000,
      30_000,
    ),
    45_000,
  )
})

// ---------------------------------------------------------------------------
// 6. cleanupSkillArtifacts removes the lifecycle path
// ---------------------------------------------------------------------------

test('fixture: cleanupSkillArtifacts removes ${env.HOME}/.config/test-host-contract', async () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const scratchHome = mkdtempSync(join(tmpdir(), 'fixture-home-'))
  try {
    await withScratchHome(scratchHome, async () => {
      // Pre-create the artifact directory so cleanup has something to remove.
      const target = join(scratchHome, '.config', 'test-host-contract')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'state.txt'), 'pretend artifact')
      assert.ok(existsSync(target))

      const controller = makeController()
      const result = await controller.cleanupSkillArtifacts(
        definition.id,
        definition.name,
        FIXTURE_DIR,
        definition.hostRequirements ?? null,
      )

      assert.equal(result.errors.length, 0, `cleanup errors: ${JSON.stringify(result.errors)}`)
      assert.equal(result.removedPaths.length, 1)
      assert.equal(result.removedPaths[0], target)
      assert.ok(!existsSync(target), 'cleanup must actually delete the directory')
    })
  } finally {
    rmSync(scratchHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. restoreSpawnContext cleans up — files are gone afterwards
// ---------------------------------------------------------------------------

test('fixture: restoreSpawnContext removes the config + secondary files that prepareSpawnContext created', async () => {
  const definition = compileSkillDefinition({
    folderPath: FIXTURE_DIR,
    source: 'embedded',
  })
  assert.ok(definition.hostRequirements)

  const controller = makeController()
  const handle = await controller.prepareSpawnContext(
    definition.id,
    definition.name,
    FIXTURE_DIR,
    definition.hostRequirements ?? null,
    'job-restore',
  )
  const cfgPath = handle.configFileBackup?.path
  const secPath = handle.secondaryFilesCreated[0]
  assert.ok(cfgPath && existsSync(cfgPath))
  assert.ok(secPath && existsSync(secPath))

  await controller.restoreSpawnContext(handle)

  // The fixture targets `${spawn.tmp_dir}/...` paths that don't pre-exist, so
  // restore must DELETE both files.
  assert.ok(!existsSync(cfgPath), `config file should be removed by restore: ${cfgPath}`)
  assert.ok(!existsSync(secPath), `secondary file should be removed by restore: ${secPath}`)
})

// ---------------------------------------------------------------------------
// 8. Architectural proof: the fixture skill name MUST NOT appear anywhere in
//    Ready source code. Adding a new skill must not require a Ready code
//    change — that's the entire promise of the Skill Host Contract.
// ---------------------------------------------------------------------------

test('architectural proof: "test-host-contract" MUST NOT appear in src/main or src/shared', () => {
  // We grep for the literal fixture id. If anyone ever hardcodes a special
  // case for this skill in Ready core code, this test fails and the contract
  // promise is broken.
  let grepResult = ''
  try {
    grepResult = execSync(
      'grep -r "test-host-contract" src/main src/shared 2>/dev/null || true',
      { encoding: 'utf-8', cwd: REPO_ROOT },
    )
  } catch {
    // grep returning non-zero (no matches) is the success case; with the
    // `|| true` shell fallback we shouldn't actually hit this catch, but be
    // defensive in case execSync wraps the exit code anyway.
    grepResult = ''
  }
  assert.strictEqual(
    grepResult.trim(),
    '',
    `Fixture skill id leaked into Ready source code:\n${grepResult}\n\n` +
      'The whole point of the Skill Host Contract is that adding a new skill ' +
      'requires ZERO changes to Ready core. If you needed to special-case this ' +
      'fixture, the contract layer is missing a generic affordance — extend the ' +
      'manifest schema, do not hardcode the skill id.',
  )
})
