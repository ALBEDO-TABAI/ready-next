/**
 * Verifies the SkillHostRequirementsSchema (B-arch-1).
 *
 * Covers the contract guarantees required by SkillHostController:
 *   1. A complete real-world fixture (mirrors VEA host_requirements in plan §5
 *      Wave C C1) parses with all defaults applied.
 *   2. Sparse / partial fixtures still parse (everything but
 *      manifest_version is optional).
 *   3. `.strict()` rejects unknown keys at the top level (and on every nested
 *      strict object), so typos cannot slip through silently.
 *   4. Default values land on .parse() output (preserve_existing=true,
 *      manifest_version=1, blocked_values default array, error_values default
 *      array, concurrency.model='serialized').
 *   5. Out-of-range / unsafe values are rejected:
 *      - default_action_timeout_ms > 1h
 *      - default_action_timeout_ms < 1s
 *      - shell_allowlist_extensions with shell-meta chars (e.g. "rm; ls",
 *        "ls|wc", spaces)
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SkillHostRequirementsSchema,
  type SkillHostRequirements,
} from '../shared/skill-host-contract'

test('SkillHostRequirementsSchema parses a complete VEA-style fixture', () => {
  const fixture = {
    manifest_version: 1 as const,
    spawn_context: {
      config_file: {
        path: '~/.config/${skill.id}/config.json',
        format: 'json' as const,
        fields: {
          '/auto_scoring/preferred_model': '${agent.model_id}',
          '/auto_scoring/fallback_models': '${agent.fallback_chain}',
          '/auto_scoring/models_json_path':
            '${spawn.tmp_dir}/models.${spawn.job_id}.json',
        },
        preserve_existing: true,
      },
      secondary_files: [
        {
          path: '${spawn.tmp_dir}/models.${spawn.job_id}.json',
          content_template:
            '{"providers":{"${agent.provider}":{"baseUrl":"${agent.base_url}"}}}',
        },
      ],
      env: {
        READY_AGENT_MODEL: '${agent.model_id}',
      },
      cwd: '${skill.assetRoot}',
    },
    shell_allowlist_extensions: ['wc'],
    default_action_timeout_ms: 1_800_000,
    status_detection: {
      method: 'sentinel_file' as const,
      file_path: '${output_dir}/run_state.json',
      json_field: 'status',
      blocked_values: ['blocked'],
      error_values: ['error', 'failed'],
    },
    lifecycle: {
      on_uninstall_remove: ['~/.config/${skill.id}'],
    },
    concurrency: {
      model: 'serialized' as const,
    },
  }

  const result = SkillHostRequirementsSchema.safeParse(fixture)
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  const parsed: SkillHostRequirements = result.data
  assert.equal(parsed.manifest_version, 1)
  assert.equal(parsed.spawn_context?.config_file?.preserve_existing, true)
  assert.equal(parsed.shell_allowlist_extensions?.[0], 'wc')
  assert.equal(parsed.default_action_timeout_ms, 1_800_000)
  assert.equal(parsed.status_detection?.method, 'sentinel_file')
  assert.deepEqual(parsed.status_detection?.blocked_values, ['blocked'])
  assert.equal(parsed.concurrency?.model, 'serialized')
})

test('SkillHostRequirementsSchema accepts a minimal fixture (only timeout)', () => {
  const fixture = {
    default_action_timeout_ms: 60_000,
  }
  const result = SkillHostRequirementsSchema.safeParse(fixture)
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  // manifest_version default lands even when caller omits it.
  assert.equal(result.data.manifest_version, 1)
  assert.equal(result.data.default_action_timeout_ms, 60_000)
  assert.equal(result.data.spawn_context, undefined)
  assert.equal(result.data.status_detection, undefined)
})

test('SkillHostRequirementsSchema accepts an empty object and applies manifest_version default', () => {
  const result = SkillHostRequirementsSchema.safeParse({})
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  assert.equal(result.data.manifest_version, 1)
})

test('SkillHostRequirementsSchema rejects unknown keys at top level', () => {
  const fixture = {
    default_action_timeout_ms: 60_000,
    // Typo: should be `lifecycle`.
    lifeCycle: { on_uninstall_remove: ['~/.cache'] },
  }
  const result = SkillHostRequirementsSchema.safeParse(fixture)
  assert.equal(result.success, false)
  if (result.success) return
  const codes = result.error.issues.map((i) => i.code)
  assert.ok(
    codes.includes('unrecognized_keys'),
    `expected unrecognized_keys, got ${JSON.stringify(result.error.issues)}`,
  )
})

test('SkillHostRequirementsSchema rejects unknown keys inside spawn_context', () => {
  const fixture = {
    spawn_context: {
      // Typo: should be `cwd`.
      workingDir: '/tmp',
    },
  }
  const result = SkillHostRequirementsSchema.safeParse(fixture)
  assert.equal(result.success, false)
  if (result.success) return
  const codes = result.error.issues.map((i) => i.code)
  assert.ok(codes.includes('unrecognized_keys'))
})

test('SkillHostRequirementsSchema applies preserve_existing=true default on config_file', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    spawn_context: {
      config_file: {
        path: '~/.config/x/config.json',
        format: 'json',
        fields: { '/a': 'b' },
      },
    },
  })
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  assert.equal(result.data.spawn_context?.config_file?.preserve_existing, true)
})

test('SkillHostRequirementsSchema applies status_detection blocked/error defaults', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    status_detection: { method: 'exit_code' },
  })
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  assert.deepEqual(result.data.status_detection?.blocked_values, [
    'blocked',
    'pending_review',
    'awaiting_input',
  ])
  assert.deepEqual(result.data.status_detection?.error_values, [
    'error',
    'failed',
  ])
})

test('SkillHostRequirementsSchema applies concurrency.model="serialized" default', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    concurrency: {},
  })
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  if (!result.success) return
  assert.equal(result.data.concurrency?.model, 'serialized')
})

test('SkillHostRequirementsSchema rejects default_action_timeout_ms above 1h', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    default_action_timeout_ms: 3_600_001,
  })
  assert.equal(result.success, false)
})

test('SkillHostRequirementsSchema rejects default_action_timeout_ms below 1s', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    default_action_timeout_ms: 999,
  })
  assert.equal(result.success, false)
})

test('SkillHostRequirementsSchema rejects shell_allowlist_extensions with shell-meta chars', () => {
  const cases: ReadonlyArray<string> = [
    'rm; ls',
    'ls|wc',
    'cat $FILE',
    'two words',
    'has/slash',
    'has.dot',
  ]
  for (const candidate of cases) {
    const result = SkillHostRequirementsSchema.safeParse({
      shell_allowlist_extensions: [candidate],
    })
    assert.equal(
      result.success,
      false,
      `expected rejection for shell_allowlist_extensions entry ${JSON.stringify(candidate)}`,
    )
  }
})

test('SkillHostRequirementsSchema accepts plain alphanumeric shell_allowlist_extensions', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    shell_allowlist_extensions: ['wc', 'pandoc', 'yt-dlp', 'ff_probe', 'ABC'],
  })
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
})

test('SkillHostRequirementsSchema rejects invalid status_detection.method', () => {
  const result = SkillHostRequirementsSchema.safeParse({
    status_detection: { method: 'process_signal' },
  })
  assert.equal(result.success, false)
})

test('SkillHostRequirementsSchema rejects invalid manifest_version', () => {
  const result = SkillHostRequirementsSchema.safeParse({ manifest_version: 2 })
  assert.equal(result.success, false)
})
