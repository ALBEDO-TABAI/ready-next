import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildImageGenerationEndpoint,
  generateImageBytes,
  resolveImageGenerationClientConfig,
  type ImageGenerationClientConfig,
} from '../main/modules/image-generation/image-generation-client'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function config(overrides: Partial<ImageGenerationClientConfig> = {}): ImageGenerationClientConfig {
  return {
    serviceId: 'image-test',
    protocol: 'openai-images',
    baseUrl: 'https://images.example.test/gateway',
    apiKey: 'test-secret',
    model: 'gpt-image-test',
    ...overrides,
  }
}

test('image generation endpoint keeps an existing API version and appends one otherwise', () => {
  assert.equal(
    buildImageGenerationEndpoint(config(), false),
    'https://images.example.test/gateway/v1/images/generations',
  )
  assert.equal(
    buildImageGenerationEndpoint(config({ baseUrl: 'https://images.example.test/v1' }), true),
    'https://images.example.test/v1/images/edits',
  )
  assert.equal(
    buildImageGenerationEndpoint(config({
      protocol: 'gemini-generate-content',
      baseUrl: 'https://gemini.example.test/c35',
      model: 'gemini-image-test',
    }), false),
    'https://gemini.example.test/c35/v1/models/gemini-image-test:generateContent',
  )
})

test('OpenAI-compatible generation sends JSON and accepts base64 image output', async () => {
  let seenUrl = ''
  let seenAuthorization = ''
  let seenBody: Record<string, unknown> | null = null
  const result = await generateImageBytes({
    config: config({ size: '1536x1024' }),
    prompt: 'orange studio object',
  }, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      seenAuthorization = new Headers(init?.headers).get('Authorization') || ''
      seenBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        data: [{ b64_json: PNG_BYTES.toString('base64') }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  })

  assert.equal(seenUrl, 'https://images.example.test/gateway/v1/images/generations')
  assert.equal(seenAuthorization, 'Bearer test-secret')
  assert.deepEqual(seenBody, {
    model: 'gpt-image-test',
    prompt: 'orange studio object',
    n: 1,
    size: '1536x1024',
  })
  assert.equal(result.mimeType, 'image/png')
  assert.deepEqual(Buffer.from(result.bytes), PNG_BYTES)
})

test('OpenAI-compatible edit sends reference images in the declared order', async () => {
  const uploadNames: string[] = []
  const result = await generateImageBytes({
    config: config(),
    prompt: 'combine the references',
    references: [
      { name: 'reference-b.png', mimeType: 'image/png', bytes: PNG_BYTES },
      { name: 'reference-a.png', mimeType: 'image/png', bytes: PNG_BYTES },
    ],
  }, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://images.example.test/gateway/v1/images/edits')
      assert.ok(init?.body instanceof FormData)
      const form = init.body as FormData
      assert.equal(form.get('model'), 'gpt-image-test')
      assert.equal(form.get('prompt'), 'combine the references')
      for (const value of form.getAll('image[]')) {
        uploadNames.push((value as File).name)
      }
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })

  assert.deepEqual(uploadNames, ['reference-b.png', 'reference-a.png'])
  assert.equal(result.extension, 'png')
})

test('Gemini generation sends prompt then ordered inline reference images', async () => {
  let seenBody: Record<string, unknown> | null = null
  const result = await generateImageBytes({
    config: config({
      protocol: 'gemini-generate-content',
      baseUrl: 'https://gemini.example.test/c35',
      model: 'gemini-image-test',
      aspectRatio: '16:9',
      imageSize: '2K',
    }),
    prompt: 'wide orange landscape',
    references: [
      { name: 'first.png', mimeType: 'image/png', bytes: Uint8Array.from([1]) },
      { name: 'second.png', mimeType: 'image/png', bytes: Uint8Array.from([2]) },
    ],
  }, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://gemini.example.test/c35/v1/models/gemini-image-test:generateContent')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret')
      seenBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: 'done' },
              { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } },
            ],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  })

  const contents = seenBody?.contents as Array<{ parts: Array<Record<string, unknown>> }>
  assert.equal(contents[0]?.parts[0]?.text, 'wide orange landscape')
  assert.equal((contents[0]?.parts[1]?.inlineData as { data: string }).data, Buffer.from([1]).toString('base64'))
  assert.equal((contents[0]?.parts[2]?.inlineData as { data: string }).data, Buffer.from([2]).toString('base64'))
  assert.deepEqual(seenBody?.generationConfig, {
    temperature: 0.4,
    topP: 0.95,
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
  })
  assert.deepEqual(Buffer.from(result.bytes), PNG_BYTES)
})

test('OpenAI-compatible URL output is downloaded and validated as an image', async () => {
  const calls: string[] = []
  const result = await generateImageBytes({ config: config(), prompt: 'download result' }, {
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (calls.length === 1) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/result.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } })
    }) as typeof fetch,
  })

  assert.deepEqual(calls, [
    'https://images.example.test/gateway/v1/images/generations',
    'https://cdn.example.test/result.png',
  ])
  assert.deepEqual(Buffer.from(result.bytes), PNG_BYTES)
})

test('image generation rejects invalid runtime config and bounded request timeout', async () => {
  assert.throws(() => resolveImageGenerationClientConfig({
    id: 'bad',
    kind: 'image-generation',
    enabled: true,
    baseUrl: 'file:///tmp/image',
    secrets: { apiKey: 'x' },
    options: { protocol: 'openai-images', model: 'x' },
  }), /http/)

  await assert.rejects(
    generateImageBytes({ config: config(), prompt: 'timeout' }, {
      timeoutMs: 5,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })) as typeof fetch,
    }),
    /请求超时/,
  )
})

test('image generation surfaces bounded upstream errors and rejects missing or invalid image content', async () => {
  await assert.rejects(
    generateImageBytes({ config: config(), prompt: 'unsupported endpoint' }, {
      fetch: (async () => new Response(JSON.stringify({
        error: { message: 'Images API is not enabled for this group' },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    }),
    /HTTP 404.*Images API is not enabled/,
  )

  await assert.rejects(
    generateImageBytes({
      config: config({ protocol: 'gemini-generate-content', model: 'gemini-image-test' }),
      prompt: 'missing image',
    }, {
      fetch: (async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'no image' }] } }],
      }), { status: 200 })) as typeof fetch,
    }),
    /没有图片/,
  )

  await assert.rejects(
    generateImageBytes({ config: config(), prompt: 'invalid bytes' }, {
      fetch: (async () => new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }],
      }), { status: 200 })) as typeof fetch,
    }),
    /不是受支持的图片/,
  )

  await assert.rejects(
    generateImageBytes({ config: config(), prompt: 'oversized response' }, {
      fetch: (async () => new Response('{}', {
        status: 200,
        headers: { 'Content-Length': '60000000' },
      })) as typeof fetch,
    }),
    /返回内容过大/,
  )
})

test('image generation forwards user cancellation as an AbortError', async () => {
  const controller = new AbortController()
  const pending = generateImageBytes({
    config: config(),
    prompt: 'cancel me',
    signal: controller.signal,
  }, {
    timeoutMs: 1_000,
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch,
  })
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
})
