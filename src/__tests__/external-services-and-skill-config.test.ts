import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeExternalServiceProfiles,
  toPublicExternalServiceProfile,
} from '../shared/external-services'
import {
  buildDefaultSkillConfigurationValues,
  normalizeSkillConfiguration,
} from '../shared/skill-configuration'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { executeWebFetch } from '../main/modules/tools/builtins/web-fetch'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('external-services-and-skill-config declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'external-services-and-skill-config transitive sqlite guard')
})
import { ExternalServiceStore } from '../main/modules/settings-engine/external-service-store'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'embedded-skills')

class InMemorySettingsRepository {
  private store = new Map<string, string>()
  getSetting(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setSetting(key: string, value: string): void {
    this.store.set(key, value)
  }
}

test('external service public profile masks secrets and preserves defaults', () => {
  const profiles = normalizeExternalServiceProfiles([
    {
      id: 'tavily-default',
      kind: 'tavily',
      name: 'Tavily Search',
      enabled: true,
      baseUrl: 'https://api.tavily.com',
      secrets: { apiKey: 'tvly-secret-123456' },
    },
  ])

  const tavily = profiles.find((profile) => profile.id === 'tavily-default')
  const ddg = profiles.find((profile) => profile.id === 'duckduckgo-default')
  assert.ok(tavily)
  assert.ok(ddg, 'normalization should keep missing default profiles')

  const publicProfile = toPublicExternalServiceProfile(tavily!)
  assert.equal(publicProfile.secretStatus.apiKey.configured, true)
  assert.equal(publicProfile.secretStatus.apiKey.masked, '••••3456')
  assert.equal('secrets' in publicProfile, false)
})

test('external service draft test uses current form values without persisting them', async () => {
  const repo = new InMemorySettingsRepository()
  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const originalFetch = globalThis.fetch
  const seenKeys: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
    seenKeys.push(url.searchParams.get('key') || '')
    return new Response(JSON.stringify({ status: '1', info: 'OK', infocode: '10000' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const result = await store.testProfileDraft({
      id: 'amap-default',
      kind: 'amap',
      enabled: true,
      baseUrl: 'https://restapi.amap.com',
      secrets: { apiKey: 'draft-test-key' },
      options: {},
    })
    assert.equal(result.ok, true)
    assert.deepEqual(seenKeys, ['draft-test-key'])
    const persisted = store.getRuntimeService('amap-default')
    assert.equal(persisted?.enabled, false)
    assert.equal(persisted?.secrets.apiKey, '')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('skill configuration normalizer keeps service bindings and defaults', () => {
  const config = normalizeSkillConfiguration({
    version: 1,
    serviceBindings: [
      {
        id: 'visionModel',
        label: '读图模型',
        allowedKinds: ['vision-model'],
        defaultServiceId: 'vision-model-default',
      },
    ],
    fields: [
      {
        id: 'subtitleModel',
        label: '字幕模型',
        type: 'select',
        defaultValue: 'base',
        options: [{ value: 'base', label: 'base' }],
      },
    ],
  })

  assert.ok(config)
  const values = buildDefaultSkillConfigurationValues(config)
  assert.equal(values.serviceBindings.visionModel, 'vision-model-default')
  assert.equal(values.fields.subtitleModel, 'base')
})

test('embedded analysis and research skills declare user-facing configuration', () => {
  const vea = compileSkillDefinition({ folderPath: join(ROOT, 'video-expert-analyzer'), source: 'embedded' })
  const copy = compileSkillDefinition({ folderPath: join(ROOT, 'video-copy-analyzer'), source: 'embedded' })
  const research = compileSkillDefinition({ folderPath: join(ROOT, 'deep-research'), source: 'embedded' })
  const rss = compileSkillDefinition({ folderPath: join(ROOT, 'lets-go-rss'), source: 'embedded' })

  assert.equal(vea.configuration?.serviceBindings.some((binding) => binding.id === 'visionModel'), true)
  assert.equal(vea.configuration?.serviceBindings.some((binding) => binding.id === 'bilibili'), true)
  assert.equal(copy.configuration?.serviceBindings.some((binding) => binding.id === 'bilibili'), true)
  assert.equal(copy.configuration?.fields.some((field) => field.id === 'subtitleModel'), false)
  assert.equal(research.configuration?.serviceBindings.some((binding) => binding.id === 'searchService'), true)
  assert.equal(research.configuration?.serviceBindings.some((binding) => binding.id === 'fetchService'), true)
  assert.equal(rss.configuration?.serviceBindings.some((binding) => binding.id === 'rsshub'), true)
})

test('web_fetch can prefer Tavily Extract when deep-research binds fetch service to Tavily', async () => {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return new Response(JSON.stringify({
      results: [
        {
          url: 'https://example.com',
          title: 'Example',
          raw_content: 'Fetched via Tavily',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await executeWebFetch(
      { url: 'https://example.com' },
      {
        tavilyKey: 'tvly-test',
        tavilyBaseUrl: 'https://search.example.test',
        preferTavilyExtract: true,
      },
    )
    assert.equal(result.content, 'Fetched via Tavily')
    assert.deepEqual(calls, ['https://search.example.test/extract'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
