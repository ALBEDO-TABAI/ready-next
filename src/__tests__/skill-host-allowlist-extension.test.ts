import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillHostController } from '../main/modules/skills-runtime/skill-host-controller'
import { SHELL_ALLOWLIST } from '../main/modules/tools/skill-primitives/run-shell'
import { SkillHostRequirementsSchema } from '../shared/skill-host-contract'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-host-allowlist-extension declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-host-allowlist-extension transitive sqlite load')
})

test('shell allowlist extensions reject destructive commands in schema', () => {
  for (const command of ['rm', 'cp', 'mv', 'dd', 'mkfs', 'chmod', 'chown', 'ln']) {
    const parsed = SkillHostRequirementsSchema.safeParse({
      shell_allowlist_extensions: [command],
    })
    assert.equal(parsed.success, false, `${command} must be rejected`)
  }

  const safe = SkillHostRequirementsSchema.safeParse({
    shell_allowlist_extensions: ['jq', 'rg', 'ffprobe'],
  })
  assert.equal(safe.success, true)
})

test('shell allowlist extensions are filtered again by SkillHostController', () => {
  const controller = new SkillHostController()
  const effective = controller.getEffectiveShellAllowlist(
    'session-a',
    'skill-a',
    SHELL_ALLOWLIST,
    {
      manifest_version: 1,
      shell_allowlist_extensions: ['rm', 'jq'],
    },
  )

  assert.equal(effective.has('jq'), true)
  assert.equal(effective.has('rm'), false)
})
