import assert from 'node:assert/strict'
import test from 'node:test'

import { isChildResumeEnabled } from '../main/modules/agent-control/skill-child-feature-flags'

test('isChildResumeEnabled returns true when env var is unset', () => {
  assert.equal(isChildResumeEnabled({}), true)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: undefined }), true)
})

test('isChildResumeEnabled returns true when env var is "1"', () => {
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: '1' }), true)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'true' }), true)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'on' }), true)
})

test('isChildResumeEnabled returns false when env var is "0"', () => {
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: '0' }), false)
})

test('isChildResumeEnabled returns false when env var is "false" / "off" (case-insensitive)', () => {
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'false' }), false)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'FALSE' }), false)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'off' }), false)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: 'OFF' }), false)
  assert.equal(isChildResumeEnabled({ READY_SKILL_CHILD_RESUME_ENABLED: '  off  ' }), false)
})
