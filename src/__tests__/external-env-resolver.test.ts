import assert from 'node:assert/strict'
import test from 'node:test'
import { ExternalEnvResolver, type ExternalEnvResolverDeps } from '../main/modules/skills-runtime/external-env-resolver'

function resolver(externalServiceStore: object, skillConfigurationStore: object): ExternalEnvResolver {
  return new ExternalEnvResolver({ externalServiceStore, skillConfigurationStore } as ExternalEnvResolverDeps)
}

test('external environment resolution rejects a service failure before reading skill configuration', async () => {
  const error = new Error('fixture service unavailable')
  let configReads = 0
  const subject = resolver({ getSkillExternalEnv: () => { throw error } }, {
    getValues: () => { configReads += 1 },
  })
  await assert.rejects(subject.resolveExternalEnv({ id: 'lets-go-rss' } as never), /external_service_unavailable.*fixture service unavailable/)
  assert.equal(configReads, 0)
})

test('external environment resolution rejects corrupt configuration instead of returning partial credentials', async () => {
  const subject = resolver({ getSkillExternalEnv: () => ({ FIXTURE_TOKEN: 'fixture-only' }) }, {
    getValues: () => { throw new Error('fixture config corrupt') },
  })
  await assert.rejects(subject.resolveExternalEnv({ id: 'video-copy-analyzer' } as never), /skill_configuration_corrupt.*fixture config corrupt/)
})

test('RSS resolution uses the selected service while unrelated skills need no external configuration', async () => {
  const services: string[] = []
  const subject = resolver({
    getSkillExternalEnv: () => ({ FIXTURE_TOKEN: 'fixture-only' }),
    getRuntimeService: (id: string) => { services.push(id); return { enabled: true, baseUrl: 'https://fixture.invalid/rss///' } },
  }, { getValues: () => ({ serviceBindings: { rsshub: 'rsshub-selected' } }) })
  assert.deepEqual(await subject.resolveExternalEnv({ id: 'lets-go-rss' } as never), {
    FIXTURE_TOKEN: 'fixture-only', RSSHUB_BASE_URL: 'https://fixture.invalid/rss',
  })
  assert.deepEqual(services, ['rsshub-selected'])
  assert.deepEqual(await resolver({}, {}).resolveExternalEnv({ id: 'unrelated' } as never), {})
})
