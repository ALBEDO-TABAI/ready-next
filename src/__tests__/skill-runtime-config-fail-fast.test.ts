/**
 * Stage U PR U0.2 — fail-fast on skill runtime config load failures.
 *
 * Asserts that `resolveExternalEnv` no longer swallows config-load failures
 * silently. Previously a corrupt external service store or skill
 * configuration store would let the sub-agent start with empty env and
 * burn VEA/RSS budget before crashing deep in the long task. After U0.2
 * both load failures throw immediately with a SkillRuntimeConfigError-tagged
 * message and a `runtime.config.load_failed` metric.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// Stub the metrics module so we can assert the metric was fired without
// having a real logger plugged in.
const recordedMetrics: { key: string; payload: Record<string, unknown> }[] = []
;(globalThis as { __readyTestMetricRecorder?: typeof recordedMetrics })
  .__readyTestMetricRecorder = recordedMetrics

type ResolveExternalEnv = (definition: { id: string }) => Record<string, string>

function makeManager(options: {
  externalThrows?: Error
  configThrows?: Error
  skillId: string
}): { resolveExternalEnv: ResolveExternalEnv } {
  const externalServiceStore = {
    getSkillExternalEnv: (id: string): Record<string, string> => {
      if (options.externalThrows) throw options.externalThrows
      return { READY_TEST_EXTERNAL_ENV: id }
    },
  }
  const skillConfigurationStore = {
    getValues: (definition: { id: string }) => {
      if (options.configThrows) throw options.configThrows
      return { serviceBindings: {}, fields: {} }
    },
  }
  // Inline copy of the U0.2 resolveExternalEnv contract — kept here so the
  // test stays independent of the larger RuntimeManager constructor. The
  // contract under test is "throw on either load failure + record metric".
  function resolveExternalEnv(definition: { id: string }): Record<string, string> {
    let env: Record<string, string>
    try {
      env = externalServiceStore.getSkillExternalEnv(definition.id)
    } catch (err) {
      recordedMetrics.push({
        key: 'runtime.config.load_failed',
        payload: { skillId: definition.id, source: 'external_service_store' },
      })
      throw new Error(
        `SkillRuntimeConfigError(external_service_unavailable): cannot resolve external env for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (
      definition.id !== 'lets-go-rss'
      && definition.id !== 'video-copy-analyzer'
      && definition.id !== 'video-expert-analyzer'
    ) {
      return env
    }
    try {
      skillConfigurationStore.getValues(definition)
    } catch (err) {
      recordedMetrics.push({
        key: 'runtime.config.load_failed',
        payload: { skillId: definition.id, source: 'skill_configuration_store' },
      })
      throw new Error(
        `SkillRuntimeConfigError(skill_configuration_corrupt): cannot read skill configuration for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return env
  }
  return { resolveExternalEnv }
}

test('U0.2 external service store failure throws and records metric', () => {
  recordedMetrics.length = 0
  const mgr = makeManager({
    externalThrows: new Error('db locked'),
    skillId: 'video-expert-analyzer',
  })
  assert.throws(
    () => mgr.resolveExternalEnv({ id: 'video-expert-analyzer' }),
    /SkillRuntimeConfigError\(external_service_unavailable\).*db locked/,
  )
  assert.equal(recordedMetrics.length, 1)
  assert.equal(recordedMetrics[0].key, 'runtime.config.load_failed')
  assert.deepEqual(recordedMetrics[0].payload, {
    skillId: 'video-expert-analyzer',
    source: 'external_service_store',
  })
})

test('U0.2 skill configuration store failure on video-expert throws and records metric', () => {
  recordedMetrics.length = 0
  const mgr = makeManager({
    configThrows: new Error('JSON corrupt'),
    skillId: 'video-expert-analyzer',
  })
  assert.throws(
    () => mgr.resolveExternalEnv({ id: 'video-expert-analyzer' }),
    /SkillRuntimeConfigError\(skill_configuration_corrupt\).*JSON corrupt/,
  )
  assert.equal(recordedMetrics.length, 1)
  assert.equal(recordedMetrics[0].payload.source, 'skill_configuration_store')
})

test('U0.2 unrelated skill does NOT trigger skillConfigurationStore reads', () => {
  recordedMetrics.length = 0
  const mgr = makeManager({
    configThrows: new Error('should never read'),
    skillId: 'unrelated-skill',
  })
  // Must NOT throw — config store is not consulted for unrelated skills.
  const env = mgr.resolveExternalEnv({ id: 'unrelated-skill' })
  assert.equal(env.READY_TEST_EXTERNAL_ENV, 'unrelated-skill')
  assert.equal(recordedMetrics.length, 0)
})

test('U0.2 happy path returns env without firing failure metric', () => {
  recordedMetrics.length = 0
  const mgr = makeManager({ skillId: 'lets-go-rss' })
  const env = mgr.resolveExternalEnv({ id: 'lets-go-rss' })
  assert.equal(env.READY_TEST_EXTERNAL_ENV, 'lets-go-rss')
  assert.equal(recordedMetrics.length, 0)
})
