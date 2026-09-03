import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillHostController } from '../main/modules/skills-runtime/skill-host-controller'
import { SHELL_ALLOWLIST } from '../main/modules/tools/skill-primitives/run-shell'
import { allowedPrimitiveToolsForSdkSkillTurn } from '../main/modules/agent-control/runtime-core/agent-sdk-skill-intent-utils'
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

test('detached lifecycle primitives stay outside the SDK safe primitive surface', () => {
  const visible = new Set(allowedPrimitiveToolsForSdkSkillTurn({
    allowAskUser: true,
    allowRunShell: true,
  }))

  for (const toolName of [
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
    'skill_inspect_run_state',
  ]) {
    assert.equal(visible.has(toolName), false, `${toolName} must remain host-owned`)
  }
})
