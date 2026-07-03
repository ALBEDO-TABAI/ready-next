/**
 * Stage S (PR-S4 / W3.2-W3.5) — provider patch profile behavior tests.
 *
 * Each profile has:
 *   - matchPredicate cases driven by `fixtures/patch-profiles.json`
 *   - request/response patcher behavior cases hand-rolled below
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { profile as geminiOAIProfile } from '../shared/ai-providers/patch-profiles/gemini-oai'
import { profile as deepseekProfile } from '../shared/ai-providers/patch-profiles/deepseek'
import { profile as minimaxProfile } from '../shared/ai-providers/patch-profiles/minimax'
import { profile as vllmProfile } from '../shared/ai-providers/patch-profiles/vllm'
import { resolveProviderPatchProfile } from '../shared/ai-providers/resolve-provider-patch-profile'
import { defaultRequestPatcher as openAIDefaultRequestPatcher } from '../shared/ai-providers/openai-compatible'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/patch-profiles.json'), 'utf8'),
) as Record<
  string,
  {
    profileId: string
    cases: Array<{
      name: string
      config: any
      baseUrl: string | null
      model: string
      expectsMatch: boolean
    }>
  }
>

function findProfileGroup(profileId: string) {
  for (const value of Object.values(FIXTURES)) {
    if (value && typeof value === 'object' && (value as any).profileId === profileId) {
      return value as { profileId: string; cases: any[] }
    }
  }
  throw new Error(`No fixture group for profileId='${profileId}'`)
}

describe('Stage S (PR-S4) — gemini-oai patch profile', () => {
  const group = findProfileGroup('gemini-oai')
  for (const c of group.cases) {
    it(`matchPredicate: ${c.name} (${c.expectsMatch ? 'match' : 'no match'})`, () => {
      const result = geminiOAIProfile.matchPredicate(c.config, c.baseUrl, c.model)
      assert.equal(Boolean(result), c.expectsMatch)
    })
  }

  it('requestPatcher preserves thought_signature on tool_calls', () => {
    const body = {
      model: 'gemini-2.0-flash-thinking',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'do_work',
                arguments: '{}',
                thought_signature: 'sig-XYZ-from-prev-turn',
              },
            },
          ],
        },
      ],
    }
    const result = geminiOAIProfile.requestPatcher!(body, {})
    const fn: any = (result.messages[1] as any).tool_calls[0].function
    assert.equal(fn.thought_signature, 'sig-XYZ-from-prev-turn')
  })

  it('requestPatcher preserves thought_signature on responses-style input', () => {
    const body = {
      model: 'gemini-2.0-flash-thinking',
      input: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'fc_1',
              thought_signature: 'sig-RESP',
            },
          ],
        },
      ],
    }
    const result = geminiOAIProfile.requestPatcher!(body, {})
    assert.equal((result.input[0] as any).tool_calls[0].thought_signature, 'sig-RESP')
  })
})

describe('Stage S (PR-S4) — deepseek patch profile', () => {
  const group = findProfileGroup('deepseek')
  for (const c of group.cases) {
    it(`matchPredicate: ${c.name} (${c.expectsMatch ? 'match' : 'no match'})`, () => {
      const result = deepseekProfile.matchPredicate(c.config, c.baseUrl, c.model)
      assert.equal(Boolean(result), c.expectsMatch)
    })
  }

  it('requestPatcher preserves reasoning_content on every assistant turn', () => {
    const body = {
      model: 'deepseek-r1',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1', reasoning_content: 'reasoning-1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2', reasoning_content: 'reasoning-2' },
      ],
    }
    const result = deepseekProfile.requestPatcher!(body, {})
    assert.equal((result.messages[1] as any).reasoning_content, 'reasoning-1')
    assert.equal((result.messages[3] as any).reasoning_content, 'reasoning-2')
  })

  it('requestPatcher does not invent reasoning_content when missing', () => {
    const body = {
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    }
    const result = deepseekProfile.requestPatcher!(body, {})
    assert.equal('reasoning_content' in (result.messages[1] as any), false)
  })

  it('does NOT touch stream_usage (preserves openai-compatible default)', () => {
    // Caller has not set stream_usage; deepseek profile must leave it
    // alone so the openai-compatible default later wins.
    const body: any = {
      model: 'deepseek-chat',
      messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }],
    }
    const result = deepseekProfile.requestPatcher!(body, {})
    assert.equal('stream_usage' in result, false)
  })
})

describe('Stage S (PR-S4) — minimax patch profile', () => {
  const group = findProfileGroup('minimax')
  for (const c of group.cases) {
    it(`matchPredicate: ${c.name} (${c.expectsMatch ? 'match' : 'no match'})`, () => {
      const result = minimaxProfile.matchPredicate(c.config, c.baseUrl, c.model)
      assert.equal(Boolean(result), c.expectsMatch)
    })
  }

  it('responsePatcher maps reasoning_details to additional_kwargs.reasoning_content', () => {
    const resp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_details: [{ text: 'step 1' }, { text: 'step 2' }],
          },
        },
      ],
    }
    const result = minimaxProfile.responsePatcher!(resp, {})
    const additional: any = (result.choices[0].message as any).additional_kwargs
    assert.equal(additional.reasoning_content, 'step 1\nstep 2')
  })

  it('responsePatcher preserves caller-supplied additional_kwargs.reasoning_content', () => {
    const resp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final',
            reasoning_details: [{ text: 'dropped' }],
            additional_kwargs: { reasoning_content: 'caller-supplied' },
          },
        },
      ],
    }
    const result = minimaxProfile.responsePatcher!(resp, {})
    assert.equal((result.choices[0].message as any).additional_kwargs.reasoning_content, 'caller-supplied')
  })

  it('responsePatcher is no-op when reasoning_details absent', () => {
    const resp = {
      choices: [{ message: { role: 'assistant', content: 'plain' } }],
    }
    const result = minimaxProfile.responsePatcher!(resp, {})
    assert.equal((result.choices[0].message as any).additional_kwargs, undefined)
  })
})

describe('Stage S (PR-S4) — vllm patch profile', () => {
  const group = findProfileGroup('vllm')
  for (const c of group.cases) {
    it(`matchPredicate: ${c.name} (${c.expectsMatch ? 'match' : 'no match'})`, () => {
      const result = vllmProfile.matchPredicate(c.config, c.baseUrl, c.model)
      assert.equal(Boolean(result), c.expectsMatch)
    })
  }

  it('requestPatcher leaves non-stream requests untouched', () => {
    const body: any = { model: 'vllm/qwen-7b', messages: [] }
    const result = vllmProfile.requestPatcher!(body, {})
    assert.equal('stream_options' in result, false)
    assert.equal('stream_usage' in result, false)
  })

  it('requestPatcher forces stream_options.include_usage and stream_usage for streams', () => {
    const body: any = { model: 'vllm/qwen-7b', messages: [], stream: true }
    const result = vllmProfile.requestPatcher!(body, {})
    assert.equal(result.stream_options.include_usage, true)
    assert.equal(result.stream_usage, true)
  })

  it('requestPatcher preserves user-supplied stream_options.include_usage = false', () => {
    const body: any = {
      model: 'vllm/qwen-7b',
      messages: [],
      stream: true,
      stream_options: { include_usage: false },
    }
    const result = vllmProfile.requestPatcher!(body, {})
    assert.equal(result.stream_options.include_usage, false)
  })

  it('requestPatcher preserves user-supplied stream_usage = false', () => {
    const body: any = {
      model: 'vllm/qwen-7b',
      messages: [],
      stream: true,
      stream_usage: false,
    }
    const result = vllmProfile.requestPatcher!(body, {})
    assert.equal(result.stream_usage, false)
  })
})

describe('Stage S (PR-S4) — resolveProviderPatchProfile', () => {
  it('returns vllm profile for /v1 baseUrl + qwen model when no official-provider id', () => {
    const profile = resolveProviderPatchProfile(null, 'https://my-vllm.example.com/v1', 'qwen-2.5-32b')
    assert.equal(profile?.profileId, 'vllm')
  })

  it('returns null for official openai provider', () => {
    const profile = resolveProviderPatchProfile({ id: 'openai' } as any, 'https://my-vllm.example.com/v1', 'qwen-2.5-32b')
    assert.equal(profile, null)
  })

  it('returns deepseek profile for api.deepseek.com baseUrl', () => {
    const profile = resolveProviderPatchProfile(null, 'https://api.deepseek.com/v1', 'deepseek-chat')
    assert.equal(profile?.profileId, 'deepseek')
  })
})

describe('Stage S (PR-S4) — patcher priority (provider default before profile)', () => {
  it('openai-compatible defaultRequestPatcher preserves non-stream stream_usage; vllm profile cannot overwrite false', () => {
    // Simulate a caller that already set stream_usage = false. The
    // provider default must NOT clobber, and the profile must NOT
    // clobber either.
    const body: any = { model: 'vllm/qwen-7b', stream_usage: false }
    openAIDefaultRequestPatcher(body)
    vllmProfile.requestPatcher!(body, {})
    assert.equal(body.stream_usage, false)
  })

  it('without user value, both default and profile leave non-stream usage fields empty', () => {
    const body: any = { model: 'vllm/qwen-7b' }
    openAIDefaultRequestPatcher(body)
    vllmProfile.requestPatcher!(body, {})
    assert.equal('stream_usage' in body, false)
    assert.equal('stream_options' in body, false)
  })

  it('without user value, both default and profile end at stream_usage = true for streams', () => {
    const body: any = { model: 'vllm/qwen-7b', stream: true }
    openAIDefaultRequestPatcher(body)
    vllmProfile.requestPatcher!(body, {})
    assert.equal(body.stream_usage, true)
    assert.equal(body.stream_options.include_usage, true)
  })
})
