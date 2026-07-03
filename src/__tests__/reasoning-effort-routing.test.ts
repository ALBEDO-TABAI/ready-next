/**
 * Stage S (PR-S6 / W4.4) — reasoning_effort routing.
 *
 * The `openai-compatible` provider patcher must strip
 * `reasoning_effort` (and the responses-API nested `reasoning.effort`
 * mirror) from the wire body when the resolved capability flag
 * `supportsThinking !== true`. When the user explicitly opts in with
 * `thinkingMode: 'on'`, the field must be preserved.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyProviderRequestPatch,
  type PatchContext,
} from '../shared/ai-providers/apply-provider-patch'
import { resolveProviderDefaultPatchers } from '../shared/ai-providers/resolve-provider-default-patchers'
import { resolveProviderPatchProfile } from '../shared/ai-providers/resolve-provider-patch-profile'

function buildCtx(opts: {
  config: any
  baseUrl: string
  model: string
}): PatchContext {
  const defaults = resolveProviderDefaultPatchers(opts.config?.provider)
  const profile = resolveProviderPatchProfile(opts.config, opts.baseUrl, opts.model)
  return {
    config: opts.config,
    baseUrl: opts.baseUrl,
    model: opts.model,
    profile,
    providerDefaultRequestPatcher: defaults.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaults.defaultResponsePatcher,
  }
}

test('openai-compatible patcher strips reasoning_effort when thinking unsupported', () => {
  const ctx = buildCtx({
    config: { provider: 'openai-compatible', model: 'unknown-model' },
    baseUrl: 'https://example.com/v1',
    model: 'unknown-model',
  })
  const body: any = { reasoning_effort: 'high', messages: [] }
  applyProviderRequestPatch(body, ctx)
  assert.equal('reasoning_effort' in body, false, 'top-level reasoning_effort must be stripped')
})

test('openai-compatible patcher strips reasoning.effort (responses-API shape) when thinking unsupported', () => {
  const ctx = buildCtx({
    config: { provider: 'openai-compatible', model: 'unknown-model' },
    baseUrl: 'https://example.com/v1',
    model: 'unknown-model',
  })
  const body: any = { reasoning: { effort: 'high' }, input: 'hi' }
  applyProviderRequestPatch(body, ctx)
  assert.equal(body.reasoning, undefined, 'reasoning object must be removed when only effort field was set')
})

test('openai-compatible patcher preserves reasoning_effort when user opts in via thinkingMode=on', () => {
  const ctx = buildCtx({
    config: { provider: 'openai-compatible', model: 'unknown-model', thinkingMode: 'on' },
    baseUrl: 'https://example.com/v1',
    model: 'unknown-model',
  })
  const body: any = { reasoning_effort: 'high', messages: [] }
  applyProviderRequestPatch(body, ctx)
  assert.equal(body.reasoning_effort, 'high', 'thinkingMode=on must keep the field')
})

test('openai-compatible patcher preserves reasoning_effort on the empty body path (nothing to strip)', () => {
  const ctx = buildCtx({
    config: { provider: 'openai-compatible', model: 'unknown-model' },
    baseUrl: 'https://example.com/v1',
    model: 'unknown-model',
  })
  const body: any = { messages: [] }
  applyProviderRequestPatch(body, ctx)
  assert.equal('stream_usage' in body, false)
  assert.equal('stream_options' in body, false)
  assert.equal('reasoning_effort' in body, false)
})
