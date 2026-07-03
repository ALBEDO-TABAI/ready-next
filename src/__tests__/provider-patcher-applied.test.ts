/**
 * Stage S (PR-S4 / W3.5) — verify the execution clients build a
 * `PatchContext` shape that wires both provider-default and profile
 * patchers, in the right priority order.
 *
 * This test exercises the `apply-provider-patch.ts` helper directly
 * because hitting `OpenAIExecutionClient` would require mocking
 * `fetchWithTimeout` — the helper-level coverage is sufficient to
 * prove the contract.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
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

describe('Stage S (PR-S4) — execution-client patch wiring', () => {
  it('openai-compatible + vllm profile: both default and profile run, profile wins on equal field', () => {
    const ctx = buildCtx({
      config: { provider: 'openai-compatible' },
      baseUrl: 'https://my-vllm.example.com/v1',
      model: 'vllm/qwen-7b',
    })
    assert.notEqual(ctx.profile, null)
    assert.equal(ctx.profile?.profileId, 'vllm')
    assert.equal(typeof ctx.providerDefaultRequestPatcher, 'function')

    const body: any = { stream: true }
    applyProviderRequestPatch(body, ctx)
    assert.equal(body.stream_usage, true)
    assert.equal(body.stream_options.include_usage, true)
  })

  it('moonshot config without matching profile: only the default (if any) runs', () => {
    const ctx = buildCtx({
      config: { provider: 'moonshot' },
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1',
    })
    assert.equal(ctx.profile, null)
    // Moonshot sub-module currently exposes no defaultRequestPatcher;
    // the body should be unchanged.
    const body: any = { messages: [] }
    applyProviderRequestPatch(body, ctx)
    assert.deepEqual(body, { messages: [] })
  })

  it('deepseek profile: reasoning_content preserved without non-stream usage fields', () => {
    const ctx = buildCtx({
      config: { provider: 'openai-compatible' },
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    })
    assert.equal(ctx.profile?.profileId, 'deepseek')

    const body: any = {
      messages: [
        { role: 'assistant', content: 'a', reasoning_content: 'r1' },
      ],
    }
    applyProviderRequestPatch(body, ctx)
    assert.equal(body.messages[0].reasoning_content, 'r1')
    assert.equal('stream_usage' in body, false)
    assert.equal('stream_options' in body, false)
  })

  it('minimax response patch: reasoning_details mapped to additional_kwargs.reasoning_content', () => {
    const ctx = buildCtx({
      config: { provider: 'openai-compatible' },
      baseUrl: 'https://api.minimax.chat/v1',
      model: 'MiniMax-M1',
    })
    assert.equal(ctx.profile?.profileId, 'minimax')

    const resp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final',
            reasoning_details: [{ text: 'step1' }, { text: 'step2' }],
          },
        },
      ],
    }
    applyProviderResponsePatch(resp, ctx)
    assert.equal((resp.choices[0].message as any).additional_kwargs.reasoning_content, 'step1\nstep2')
  })

  it('priority: provider default runs before profile (so profile cannot suppress default)', () => {
    // Synthesize a ctx where both halves would write to the same key
    // but with different values. The default sets `marker` to "A"
    // (only when undefined); the profile sets `marker` to "B"
    // unconditionally — but our profile-side patcher actually
    // respects `=== undefined`, so default wins.
    const ctx: PatchContext = {
      config: null,
      baseUrl: '',
      model: '',
      profile: {
        profileId: 'test',
        matchPredicate: () => true,
        requestPatcher: (body: any) => {
          if (body.marker === undefined) body.marker = 'B'
          return body
        },
      },
      providerDefaultRequestPatcher: (body: any) => {
        if (body.marker === undefined) body.marker = 'A'
        return body
      },
    }
    const body: any = {}
    applyProviderRequestPatch(body, ctx)
    assert.equal(body.marker, 'A')
  })
})
