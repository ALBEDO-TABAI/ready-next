/**
 * B-arch-3 — SkillHostController contract tests.
 *
 * Covers:
 *   - prepareSpawnContext writes config + secondary files
 *   - restoreSpawnContext is byte-faithful (existing file → restored exactly)
 *   - restoreSpawnContext deletes our file when none existed beforehand
 *   - Per-skill mutex serializes concurrent spawns of the SAME skill
 *   - Different skills run concurrently (no cross-skill block)
 *   - detectStatus for each method (exit_code, stdout_json_line, sentinel_file)
 *     including blocked detection
 *   - cleanupSkillArtifacts removes declared paths (and rejects out-of-root)
 *   - Path traversal rejection (e.g. ~/../etc/passwd)
 *   - Missing agent context → prepareSpawnContext throws
 *   - Templater stub refactor: contract-templater re-exports AgentSpawnContext
 *     from skill-host-contract (verified by source-text grep)
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  SkillHostController,
  SkillHostContextError,
  SkillHostPathError,
  _resetSkillHostControllerForTests,
  getSkillHostController,
} from '../main/modules/skills-runtime/skill-host-controller'
import type { SkillHostRequirements } from '../shared/skill-host-contract'
import type { AgentSpawnContext } from '../shared/skill-host-contract'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentSpawnContext> = {}): AgentSpawnContext {
  return {
    provider: 'kimi',
    model_id: 'kimi-k2',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-test-DO-NOT-LEAK',
    api_kind: 'anthropic-messages',
    fallback_chain: [],
    ...overrides,
  }
}

function makeController(opts: {
  agent?: AgentSpawnContext | null
  warn?: (m: string) => void
} = {}): SkillHostController {
  const agent = opts.agent === undefined ? makeAgent() : opts.agent
  return new SkillHostController({
    readAgentContext: async () => agent,
    warn: opts.warn,
  })
}

function makeWorkRoot(): string {
  // mkdtemp under os.tmpdir() so the controller's path-guard accepts it.
  return mkdtempSync(join(tmpdir(), 'skill-host-controller-test-'))
}

// ---------------------------------------------------------------------------
// Templater refactor verification
// ---------------------------------------------------------------------------

test('contract-templater imports AgentSpawnContext from skill-host-contract (no local stub)', async () => {
  const path = fileURLToPath(
    new URL('../main/modules/skills-runtime/contract-templater.ts', import.meta.url),
  )
  const source = readFileSync(path, 'utf8')
  // Local interface stub must be gone.
  assert.ok(
    !/\binterface\s+AgentSpawnContext\b/.test(source),
    'contract-templater.ts should no longer declare a local AgentSpawnContext interface',
  )
  // Import from skill-host-contract must be present.
  assert.match(
    source,
    /import\s+type\s+\{\s*AgentSpawnContext\s*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/shared\/skill-host-contract['"]/,
    'contract-templater.ts must import AgentSpawnContext from shared/skill-host-contract',
  )
})

// ---------------------------------------------------------------------------
// prepareSpawnContext / restoreSpawnContext
// ---------------------------------------------------------------------------

test('prepareSpawnContext writes config + secondary files, restore deletes them when none existed', async () => {
  const root = makeWorkRoot()
  try {
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: {
          path: `${root}/config/skill-config.json`,
          format: 'json',
          fields: {
            '/auto_scoring/preferred_model': '${agent.model_id}',
            '/auto_scoring/provider': '${agent.provider}',
          },
          preserve_existing: true,
        },
        secondary_files: [
          {
            path: `${root}/extras/notes.txt`,
            content_template: 'spawn ${spawn.job_id} for ${skill.id}',
          },
        ],
      },
    }
    const controller = makeController()
    const handle = await controller.prepareSpawnContext(
      'test-skill', 'Test Skill', '/skills/test', requirements, 'job-1',
    )
    try {
      const cfgPath = `${root}/config/skill-config.json`
      const secPath = `${root}/extras/notes.txt`
      assert.ok(existsSync(cfgPath), 'config file should exist')
      assert.ok(existsSync(secPath), 'secondary file should exist')

      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      const auto = cfg['auto_scoring'] as Record<string, unknown>
      assert.equal(auto['preferred_model'], 'kimi-k2')
      assert.equal(auto['provider'], 'kimi')

      const sec = readFileSync(secPath, 'utf8')
      assert.match(sec, /^spawn [0-9a-f]{8} for test-skill$/)

      assert.equal(handle.skillId, 'test-skill')
      assert.equal(handle.jobId, 'job-1')
      assert.equal(handle.secondaryFilesCreated.length, 1)
      assert.ok(handle.configFileBackup)
      assert.equal(handle.configFileBackup!.existed, false)
      assert.equal(handle.configFileBackup!.content, null)
    } finally {
      await controller.restoreSpawnContext(handle)
    }

    // After restore: both files should be gone.
    assert.ok(!existsSync(`${root}/config/skill-config.json`), 'config should be removed (no prior file)')
    assert.ok(!existsSync(`${root}/extras/notes.txt`), 'secondary should be removed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing config → backed up → modified → restored byte-for-byte', async () => {
  const root = makeWorkRoot()
  try {
    const cfgPath = `${root}/c.json`
    const original = JSON.stringify({
      user_kept: 'this should survive end-to-end',
      auto_scoring: { preferred_model: 'OLD', extra_field: 'keepme' },
    }, null, 2)
    mkdirSync(root, { recursive: true })
    writeFileSync(cfgPath, original, 'utf8')

    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: {
          path: cfgPath,
          format: 'json',
          fields: { '/auto_scoring/preferred_model': '${agent.model_id}' },
          preserve_existing: true,
        },
      },
    }
    const controller = makeController()
    const handle = await controller.prepareSpawnContext(
      's2', 'S2', '/skills/s2', requirements, 'job-2',
    )

    // While spawned: config should be modified (kimi-k2 in place of OLD), but
    // user_kept and extra_field must still be present (preserve_existing).
    const mid = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    const auto = mid['auto_scoring'] as Record<string, unknown>
    assert.equal(auto['preferred_model'], 'kimi-k2')
    assert.equal(auto['extra_field'], 'keepme')
    assert.equal(mid['user_kept'], 'this should survive end-to-end')

    await controller.restoreSpawnContext(handle)

    // After restore: byte-for-byte original.
    const restored = readFileSync(cfgPath, 'utf8')
    assert.equal(restored, original, 'restore must produce a byte-identical file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restoreSpawnContext is idempotent (calling twice is safe)', async () => {
  const root = makeWorkRoot()
  try {
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: {
          path: `${root}/c.json`,
          format: 'json',
          fields: { '/x': '${agent.model_id}' },
        },
      },
    }
    const controller = makeController()
    const handle = await controller.prepareSpawnContext(
      's3', 'S3', '/skills/s3', requirements, 'job-3',
    )
    await controller.restoreSpawnContext(handle)
    // Second call must not throw.
    await controller.restoreSpawnContext(handle)
    assert.ok(!existsSync(`${root}/c.json`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepareSpawnContext throws when no agent context is available', async () => {
  const controller = makeController({ agent: null })
  const requirements: SkillHostRequirements = { manifest_version: 1 }
  await assert.rejects(
    () => controller.prepareSpawnContext('s', 'S', '/x', requirements, 'job'),
    SkillHostContextError,
  )
})

test('prepareSpawnContext uses an explicit agent context over the default reader', async () => {
  const root = makeWorkRoot()
  try {
    const cfgPath = `${root}/c.json`
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: {
          path: cfgPath,
          format: 'json',
          fields: {
            '/auto_scoring/preferred_model': '${agent.provider}/${agent.model_id}',
            '/auto_scoring/api': '${agent.api_kind}',
          },
          preserve_existing: true,
        },
      },
    }
    const controller = makeController({
      agent: makeAgent({
        provider: 'old-provider',
        model_id: 'old-model',
        api_kind: 'openai-completions',
      }),
    })
    const handle = await controller.prepareSpawnContext(
      's-current', 'S Current', '/x', requirements, 'job-current', undefined,
      makeAgent({
        provider: 'current-provider',
        model_id: 'current-model',
        api_kind: 'openai-responses',
      }),
    )
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      const auto = cfg['auto_scoring'] as Record<string, unknown>
      assert.equal(auto['preferred_model'], 'current-provider/current-model')
      assert.equal(auto['api'], 'openai-responses')
    } finally {
      await controller.restoreSpawnContext(handle)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock is RELEASED if prepareSpawnContext throws (downstream failure)', async () => {
  const root = makeWorkRoot()
  try {
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        // path resolves to outside any allowed root → resolveAndGuardPath throws
        config_file: {
          path: '/etc/definitely-not-allowed.json',
          format: 'json',
          fields: { '/x': '${agent.model_id}' },
        },
      },
    }
    const controller = makeController()
    await assert.rejects(
      () => controller.prepareSpawnContext('s', 'S', '/x', requirements, 'job'),
      SkillHostPathError,
    )
    // After the throw, the lock for 's' should be free → a fresh prepare with
    // a valid config must succeed without hanging.
    const okReq: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: { path: `${root}/ok.json`, format: 'json', fields: { '/y': '${agent.model_id}' } },
      },
    }
    const handle = await controller.prepareSpawnContext('s', 'S', '/x', okReq, 'job')
    await controller.restoreSpawnContext(handle)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Per-skill mutex
// ---------------------------------------------------------------------------

test('per-skill mutex serializes concurrent spawns of the SAME skill', async () => {
  const root = makeWorkRoot()
  try {
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: { path: `${root}/c.json`, format: 'json', fields: { '/x': '${agent.model_id}' } },
      },
      concurrency: { model: 'serialized' },
    }
    const controller = makeController()
    const events: string[] = []

    async function run(label: string): Promise<void> {
      events.push(`enter:${label}`)
      const handle = await controller.prepareSpawnContext('locked-skill', 'L', '/x', requirements, label)
      events.push(`acquired:${label}`)
      // Hold the lock briefly.
      await new Promise((res) => setTimeout(res, 30))
      events.push(`releasing:${label}`)
      await controller.restoreSpawnContext(handle)
      events.push(`done:${label}`)
    }

    await Promise.all([run('A'), run('B')])

    // Both 'enter' events fire immediately. The acquire/release pairs must
    // not interleave: A's release must happen before B's acquire (or vice
    // versa).
    const idxAcqA = events.indexOf('acquired:A')
    const idxRelA = events.indexOf('releasing:A')
    const idxAcqB = events.indexOf('acquired:B')
    const idxRelB = events.indexOf('releasing:B')
    assert.ok(idxAcqA >= 0 && idxRelA >= 0 && idxAcqB >= 0 && idxRelB >= 0)
    const aFirst = idxAcqA < idxAcqB
    if (aFirst) {
      assert.ok(idxRelA < idxAcqB, `A must finish before B acquires; events=${JSON.stringify(events)}`)
    } else {
      assert.ok(idxRelB < idxAcqA, `B must finish before A acquires; events=${JSON.stringify(events)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('different skills run concurrently (no cross-skill block)', async () => {
  const root = makeWorkRoot()
  try {
    const reqFor = (id: string): SkillHostRequirements => ({
      manifest_version: 1,
      spawn_context: {
        config_file: { path: `${root}/${id}.json`, format: 'json', fields: { '/x': '${agent.model_id}' } },
      },
      concurrency: { model: 'serialized' },
    })
    const controller = makeController()
    const events: string[] = []

    async function run(skillId: string): Promise<void> {
      const handle = await controller.prepareSpawnContext(skillId, skillId, '/x', reqFor(skillId), skillId)
      events.push(`acquired:${skillId}`)
      await new Promise((res) => setTimeout(res, 30))
      events.push(`releasing:${skillId}`)
      await controller.restoreSpawnContext(handle)
    }

    await Promise.all([run('alpha'), run('beta')])

    // Both acquires should appear before either release (overlap proves no cross-skill block).
    const acqs = events.slice(0, 2).filter((e) => e.startsWith('acquired:'))
    assert.equal(acqs.length, 2, `expected both acquires before any release; events=${JSON.stringify(events)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("'shared' concurrency mode skips the per-skill lock", async () => {
  const root = makeWorkRoot()
  try {
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        // Use distinct files per spawn so writes don't collide.
        config_file: {
          path: `${root}/${'${spawn.job_id}'}.json`,
          format: 'json',
          fields: { '/x': '${agent.model_id}' },
        },
      },
      concurrency: { model: 'shared' },
    }
    const controller = makeController()
    const events: string[] = []
    async function run(label: string): Promise<void> {
      const handle = await controller.prepareSpawnContext('shared-skill', 'S', '/x', requirements, label)
      events.push(`acquired:${label}`)
      await new Promise((res) => setTimeout(res, 20))
      events.push(`releasing:${label}`)
      await controller.restoreSpawnContext(handle)
    }
    await Promise.all([run('A'), run('B')])
    const firstTwo = events.slice(0, 2)
    assert.deepEqual(firstTwo.sort(), ['acquired:A', 'acquired:B'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// detectStatus
// ---------------------------------------------------------------------------

test('detectStatus exit_code: zero → done, non-zero → error', async () => {
  const c = makeController()
  assert.deepEqual(await c.detectStatus(null, { exitCode: 0, stdout: '', stderr: '' }),
    { status: 'done' })
  const errReport = await c.detectStatus(null, { exitCode: 2, stdout: '', stderr: '' })
  assert.equal(errReport.status, 'error')
  assert.match(errReport.detail ?? '', /exit_code=2/)
})

test('detectStatus stdout_json_line: parses last JSON line and maps blocked/error/done', async () => {
  const c = makeController()
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    status_detection: {
      method: 'stdout_json_line',
      json_field: 'status',
      blocked_values: ['blocked', 'awaiting_input'],
      error_values: ['error', 'failed'],
    },
  }

  const blockedOut = 'noise line\n{"status":"blocked","step":4}\n'
  const blocked = await c.detectStatus(requirements, { exitCode: 0, stdout: blockedOut, stderr: '' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.detail, 'blocked')

  const errorOut = '{"status":"failed","reason":"x"}'
  const errR = await c.detectStatus(requirements, { exitCode: 0, stdout: errorOut, stderr: '' })
  assert.equal(errR.status, 'error')
  assert.equal(errR.detail, 'failed')

  const doneOut = '{"status":"done"}'
  const done = await c.detectStatus(requirements, { exitCode: 0, stdout: doneOut, stderr: '' })
  assert.equal(done.status, 'done')

  const runningOut = '{"status":"running"}'
  const running = await c.detectStatus(requirements, { exitCode: 0, stdout: runningOut, stderr: '' })
  assert.equal(running.status, 'blocked')
  assert.equal(running.detail, 'running')

  // No JSON line + exit 0 → done.
  const noJson = await c.detectStatus(requirements, { exitCode: 0, stdout: 'plain text', stderr: '' })
  assert.equal(noJson.status, 'done')

  // Only the LAST JSON line counts.
  const multi = '{"status":"failed"}\n{"status":"done"}'
  const last = await c.detectStatus(requirements, { exitCode: 0, stdout: multi, stderr: '' })
  assert.equal(last.status, 'done')
})

test('detectStatus sentinel_file: reads JSON file and maps fields', async () => {
  const root = makeWorkRoot()
  try {
    const sentinel = `${root}/state.json`
    const c = makeController()
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      status_detection: {
        method: 'sentinel_file',
        file_path: sentinel,
        json_field: 'phase',
        blocked_values: ['blocked'],
        error_values: ['error'],
      },
    }

    // Missing file + exit 0 → done.
    const missing = await c.detectStatus(requirements, { exitCode: 0, stdout: '', stderr: '' }, root)
    assert.equal(missing.status, 'done')

    // Sentinel says blocked.
    writeFileSync(sentinel, JSON.stringify({ phase: 'blocked', detail: 'reason' }))
    const blocked = await c.detectStatus(requirements, { exitCode: 0, stdout: '', stderr: '' }, root)
    assert.equal(blocked.status, 'blocked')

    // Sentinel says error.
    writeFileSync(sentinel, JSON.stringify({ phase: 'error' }))
    const errR = await c.detectStatus(requirements, { exitCode: 0, stdout: '', stderr: '' }, root)
    assert.equal(errR.status, 'error')

    // Sentinel says done.
    writeFileSync(sentinel, JSON.stringify({ phase: 'done' }))
    const done = await c.detectStatus(requirements, { exitCode: 0, stdout: '', stderr: '' }, root)
    assert.equal(done.status, 'done')

    // Sentinel exists but the declared field is missing: never treat that as done.
    writeFileSync(sentinel, JSON.stringify({ message: 'failed but no phase' }))
    const missingField = await c.detectStatus(requirements, { exitCode: 1, stdout: '', stderr: '' }, root)
    assert.equal(missingField.status, 'error')
    assert.match(missingField.detail ?? '', /sentinel_field_missing: phase/)

    // Malformed JSON → error.
    writeFileSync(sentinel, 'not-valid-json {')
    const bad = await c.detectStatus(requirements, { exitCode: 0, stdout: '', stderr: '' }, root)
    assert.equal(bad.status, 'error')
    assert.match(bad.detail ?? '', /sentinel_parse_failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// getEffectiveShellAllowlist
// ---------------------------------------------------------------------------

test('getEffectiveShellAllowlist merges extensions only when sessionId+referenceSkillId match', () => {
  const c = makeController()
  const base: ReadonlySet<string> = new Set(['python', 'bash'])
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    shell_allowlist_extensions: ['ffmpeg', 'yt-dlp'],
  }

  const noSession = c.getEffectiveShellAllowlist(undefined, 'skill-x', base, requirements)
  assert.deepEqual([...noSession].sort(), ['bash', 'python'])

  const noHint = c.getEffectiveShellAllowlist('sess', null, base, requirements)
  assert.deepEqual([...noHint].sort(), ['bash', 'python'])

  const merged = c.getEffectiveShellAllowlist('sess', 'skill-x', base, requirements)
  assert.deepEqual([...merged].sort(), ['bash', 'ffmpeg', 'python', 'yt-dlp'])

  // Without requirements: base allowlist only.
  const blank = c.getEffectiveShellAllowlist('sess', 'skill-x', base, null)
  assert.deepEqual([...blank].sort(), ['bash', 'python'])
})

// ---------------------------------------------------------------------------
// getEffectiveActionTimeout
// ---------------------------------------------------------------------------

test('getEffectiveActionTimeout: per-action > requirements > fallback', () => {
  const c = makeController()
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    default_action_timeout_ms: 60_000,
  }
  // per-action wins
  assert.equal(c.getEffectiveActionTimeout(requirements, 5_000, 999_999), 5_000)
  // requirements wins
  assert.equal(c.getEffectiveActionTimeout(requirements, undefined, 999_999), 60_000)
  // fallback wins
  assert.equal(c.getEffectiveActionTimeout(null, undefined, 30_000), 30_000)
  // 0 / NaN per-action → ignored, falls back
  assert.equal(c.getEffectiveActionTimeout(null, 0, 30_000), 30_000)
  assert.equal(c.getEffectiveActionTimeout(null, Number.NaN, 30_000), 30_000)
})

// ---------------------------------------------------------------------------
// cleanupSkillArtifacts
// ---------------------------------------------------------------------------

test('cleanupSkillArtifacts removes declared paths', async () => {
  const root = makeWorkRoot()
  try {
    const a = `${root}/a.txt`
    const b = `${root}/dir-b`
    writeFileSync(a, 'a-data')
    mkdirSync(b, { recursive: true })
    writeFileSync(`${b}/inside.txt`, 'inside-data')

    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      lifecycle: { on_uninstall_remove: [a, b] },
    }
    const c = makeController()
    const result = await c.cleanupSkillArtifacts('s', 'S', '/x', requirements)
    assert.equal(result.errors.length, 0)
    assert.deepEqual(result.removedPaths.sort(), [a, b].sort())
    assert.ok(!existsSync(a))
    assert.ok(!existsSync(b))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanupSkillArtifacts rejects out-of-root paths via path-guard', async () => {
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    lifecycle: { on_uninstall_remove: ['/etc/definitely-not-allowed'] },
  }
  const c = makeController()
  const result = await c.cleanupSkillArtifacts('s', 'S', '/x', requirements)
  assert.equal(result.removedPaths.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /escapes allowed roots/)
})

// ---------------------------------------------------------------------------
// Path traversal rejection
// ---------------------------------------------------------------------------

test('path traversal: ~/../etc/passwd → SkillHostPathError', async () => {
  // `~/../etc/passwd` expands to `<home>/../etc/passwd` which path.resolve
  // collapses to `/etc/passwd` (or similar) — well outside HOME / tmp / xdg.
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    spawn_context: {
      config_file: {
        path: '~/../../etc/passwd-ready-test',
        format: 'json',
        fields: { '/x': '${agent.model_id}' },
      },
    },
  }
  const c = makeController()
  await assert.rejects(
    () => c.prepareSpawnContext('s', 'S', '/x', requirements, 'job'),
    SkillHostPathError,
  )
})

test('path traversal: secondary file with /etc/... → rejected', async () => {
  const requirements: SkillHostRequirements = {
    manifest_version: 1,
    spawn_context: {
      secondary_files: [
        { path: '/etc/passwd-ready-test', content_template: 'evil' },
      ],
    },
  }
  const c = makeController()
  await assert.rejects(
    () => c.prepareSpawnContext('s', 'S', '/x', requirements, 'job'),
    SkillHostPathError,
  )
})

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

test('getSkillHostController returns a singleton', () => {
  _resetSkillHostControllerForTests()
  const a = getSkillHostController()
  const b = getSkillHostController()
  assert.strictEqual(a, b)
  _resetSkillHostControllerForTests()
})

// ---------------------------------------------------------------------------
// api_key never leaked through warn / error messages
// ---------------------------------------------------------------------------

test('warn sink never receives api_key value', async () => {
  const root = makeWorkRoot()
  try {
    const warnings: string[] = []
    const secret = 'sk-MUST-NOT-LEAK-anywhere-in-warnings'
    const c = makeController({
      agent: makeAgent({ api_key: secret }),
      warn: (m) => warnings.push(m),
    })

    // Force an error path: pre-write an unreadable file so backup-read warns.
    // Simpler: trigger restore-time warning by re-using a stale handle.
    const requirements: SkillHostRequirements = {
      manifest_version: 1,
      spawn_context: {
        config_file: { path: `${root}/c.json`, format: 'json', fields: { '/x': '${agent.model_id}' } },
        secondary_files: [
          { path: `${root}/sub/sec.txt`, content_template: 'value=${agent.model_id}' },
        ],
      },
    }
    const handle = await c.prepareSpawnContext('s', 'S', '/x', requirements, 'job')

    // Pre-delete the secondary so restore hits ENOENT (no warning expected).
    rmSync(`${root}/sub/sec.txt`, { force: true })
    await c.restoreSpawnContext(handle)

    for (const w of warnings) {
      assert.ok(!w.includes(secret), `warning leaked api_key: ${w}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
