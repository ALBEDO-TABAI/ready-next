import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { SkillDomainAdapter } from '../main/modules/agent-control/skills/skill-domain-adapter'

// skill-resume plan D3 — when isRetryOnlyTurn=true (user said "继续/重试/接着"),
// the SkillDomainAdapter widens its prefix narrowing to also keep file_/document_
// tools. Without this, retry turns drop those tools and the agent has no way to
// inspect prior state (root cause of the recent RSS-loop bug at 15:50:30 where
// `tool execute: file_search, result=Tool not allowed in current context`).

const ALLOWED = [
  'skill_run_shell',
  'skill_video_expert_pipeline',
  'memory_search',
  'session_search',
  'file_search',
  'file_locate',
  'document_open_tab',
  'document_set_content',
  'browser_open_url',
  'rss_list_sources',
]

interface PrepareParamsLike {
  route: unknown
  request: unknown
  host: { log: (msg: string) => void }
  session: unknown
  userText: string
  pureUserInput: string
  requestEnvelope: unknown
  executionIntentContext: unknown
  hasTools: boolean
  toolPolicy: unknown
  allowedToolNames: string[]
  isRetryOnlyTurn?: boolean
}

function buildParams(overrides: Partial<PrepareParamsLike>): PrepareParamsLike {
  return {
    route: { executor: 'skill', chain: 'direct' },
    request: {},
    host: { log: () => undefined },
    session: { messages: [] },
    userText: '',
    pureUserInput: '',
    requestEnvelope: {},
    executionIntentContext: null,
    hasTools: true,
    toolPolicy: {},
    allowedToolNames: ALLOWED,
    isRetryOnlyTurn: false,
    ...overrides,
  }
}

describe('SkillDomainAdapter D3 retry-widen narrowing', () => {
  it('default narrowing (isRetryOnlyTurn=false): only skill_/memory_/session_ kept', () => {
    const adapter = new SkillDomainAdapter()
    const result = adapter.prepare(buildParams({ isRetryOnlyTurn: false }) as Parameters<typeof adapter.prepare>[0])
    const allowed = (result?.allowedToolNames as string[] | null) ?? []
    assert.ok(allowed.includes('skill_run_shell'), 'skill_run_shell kept')
    assert.ok(allowed.includes('memory_search'), 'memory_search kept')
    assert.ok(allowed.includes('session_search'), 'session_search kept')
    assert.ok(!allowed.includes('file_search'), 'file_search dropped (default)')
    assert.ok(!allowed.includes('file_locate'), 'file_locate dropped (default)')
    assert.ok(!allowed.includes('document_open_tab'), 'document_open_tab dropped (default)')
    assert.ok(!allowed.includes('browser_open_url'), 'browser_open_url dropped (always — outside both sets)')
    assert.ok(!allowed.includes('rss_list_sources'), 'rss_list_sources dropped (always — no skill_ prefix)')
  })

  it('retry-intent narrowing (isRetryOnlyTurn=true): file_/document_ also kept', () => {
    const adapter = new SkillDomainAdapter()
    const result = adapter.prepare(buildParams({ isRetryOnlyTurn: true }) as Parameters<typeof adapter.prepare>[0])
    const allowed = (result?.allowedToolNames as string[] | null) ?? []
    assert.ok(allowed.includes('skill_run_shell'), 'skill_run_shell kept')
    assert.ok(allowed.includes('memory_search'), 'memory_search kept')
    assert.ok(allowed.includes('session_search'), 'session_search kept')
    assert.ok(allowed.includes('file_search'), 'file_search kept (retry widen)')
    assert.ok(allowed.includes('file_locate'), 'file_locate kept (retry widen)')
    assert.ok(allowed.includes('document_open_tab'), 'document_open_tab kept (retry widen)')
    assert.ok(allowed.includes('document_set_content'), 'document_set_content kept (retry widen)')
    assert.ok(!allowed.includes('browser_open_url'), 'browser_open_url still dropped (outside widen list)')
    assert.ok(!allowed.includes('rss_list_sources'), 'rss_list_sources still dropped (outside widen list)')
  })

  it('isRetryOnlyTurn omitted defaults to false', () => {
    const adapter = new SkillDomainAdapter()
    const params = buildParams({})
    delete params.isRetryOnlyTurn
    const result = adapter.prepare(params as Parameters<typeof adapter.prepare>[0])
    const allowed = (result?.allowedToolNames as string[] | null) ?? []
    assert.ok(!allowed.includes('file_search'), 'file_search dropped (omitted treated as false)')
  })
})
