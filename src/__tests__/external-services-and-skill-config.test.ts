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
  const anysearch = profiles.find((profile) => profile.id === 'anysearch-default')
  const gptImage = profiles.find((profile) => profile.id === 'gpt-image-default')
  const geminiImage = profiles.find((profile) => profile.id === 'gemini-image-default')
  assert.ok(tavily)
  assert.ok(ddg, 'normalization should keep missing default profiles')
  assert.ok(anysearch, 'normalization should add the AnySearch default profile')
  assert.equal(anysearch?.enabled, false)
  assert.equal(anysearch?.baseUrl, 'https://api.anysearch.com/mcp')
  assert.deepEqual(gptImage?.options, {
    protocol: 'openai-images',
    model: 'gpt-image-2',
    size: '1024x1024',
  })
  assert.deepEqual(geminiImage?.options, {
    protocol: 'gemini-generate-content',
    model: 'gemini-3.1-flash-image',
    aspectRatio: '1:1',
    imageSize: '1K',
  })
  assert.equal(gptImage?.enabled, false)
  assert.equal(geminiImage?.enabled, false)

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

test('AnySearch draft test uses the unsaved key and runtime config keeps it encrypted behind the store', async () => {
  const repo = new InMemorySettingsRepository()
  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const originalFetch = globalThis.fetch
  let authorization = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get('Authorization') || ''
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '## Search Results (0 results)' }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await store.testProfileDraft({
      id: 'anysearch-default',
      kind: 'anysearch',
      enabled: true,
      baseUrl: 'https://api.anysearch.test/mcp',
      secrets: { apiKey: 'draft-anysearch-key' },
      options: {},
    })
    assert.equal(result.ok, true)
    assert.equal(authorization, 'Bearer draft-anysearch-key')
    assert.equal(store.getRuntimeService('anysearch-default')?.enabled, false, 'draft test must not persist')

    await store.upsertProfile({
      id: 'anysearch-default',
      kind: 'anysearch',
      enabled: true,
      baseUrl: 'https://api.anysearch.test/mcp',
      secrets: { apiKey: 'saved-anysearch-key' },
    })
    const publicProfile = store.getPublicProfile('anysearch-default')
    assert.equal(publicProfile?.secretStatus.apiKey.configured, true)
    assert.equal('secrets' in (publicProfile || {}), false)
    assert.equal(store.getGeneralResearchConfig().anysearchKey, 'saved-anysearch-key')
    assert.doesNotMatch(repo.getSetting('external_service_profiles_v1') || '', /saved-anysearch-key/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('skill env never receives an unrelated configured credential', async () => {
  const repo = new InMemorySettingsRepository()
  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  await store.upsertProfile({
    id: 'github-default',
    kind: 'github',
    enabled: true,
    secrets: { token: 'github-secret-that-must-stay-scoped' },
  })

  assert.deepEqual(store.getSkillExternalEnv('unrelated-custom-skill'), {})
  assert.deepEqual(store.getSkillExternalEnv('video-expert-analyzer'), {})
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
  const anysearch = compileSkillDefinition({ folderPath: join(ROOT, 'anysearch'), source: 'embedded' })
  const rss = compileSkillDefinition({ folderPath: join(ROOT, 'lets-go-rss'), source: 'embedded' })

  assert.equal(vea.configuration?.serviceBindings.some((binding) => binding.id === 'visionModel'), true)
  assert.equal(vea.configuration?.serviceBindings.some((binding) => binding.id === 'bilibili'), true)
  assert.equal(copy.configuration?.serviceBindings.some((binding) => binding.id === 'bilibili'), true)
  assert.equal(copy.configuration?.fields.some((field) => field.id === 'subtitleModel'), false)
  assert.equal(research.configuration?.serviceBindings.some((binding) => binding.id === 'searchService'), true)
  assert.equal(research.configuration?.serviceBindings.some((binding) => binding.id === 'fetchService'), true)
  assert.equal(
    research.configuration?.serviceBindings.find((binding) => binding.id === 'searchService')?.allowedKinds.includes('anysearch'),
    true,
  )
  assert.equal(
    research.configuration?.serviceBindings.find((binding) => binding.id === 'fetchService')?.allowedKinds.includes('anysearch'),
    true,
  )
  assert.equal(anysearch.executionMode, 'advisory')
  assert.equal(anysearch.configuration?.serviceBindings.find((binding) => binding.id === 'searchService')?.defaultServiceId, 'anysearch-default')
  assert.equal(anysearch.configuration?.serviceBindings.find((binding) => binding.id === 'fetchService')?.defaultServiceId, 'anysearch-default')
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
