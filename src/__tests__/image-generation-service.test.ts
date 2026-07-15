import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ImageGenerationService,
  resolveOrderedImageReferences,
} from '../main/modules/image-generation/image-generation-service'
import type { RuntimeExternalServiceConfig } from '../shared/external-services'
import { IMAGE_GENERATION_MAX_OUTPUT_BYTES } from '../shared/image-generation'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function imageServiceConfig(): RuntimeExternalServiceConfig {
  return {
    id: 'gpt-image-test',
    kind: 'image-generation',
    enabled: true,
    baseUrl: 'https://images.example.test',
    secrets: { apiKey: 'test-secret' },
    options: { protocol: 'openai-images', model: 'gpt-image-test', size: '1024x1024' },
  }
}

test('reference image labels follow envelope order and requested subsets must stay ordered', () => {
  const envelope = {
    resources: [
      { kind: 'attachment', source: 'user_attachment', name: 'later.png', path: '/tmp/later.png', order: 20 },
      { kind: 'attachment', source: 'explicit_reference', name: 'first.png', path: '/tmp/first.png', order: 10 },
      { kind: 'attachment', source: 'current_document', name: 'stale.png', path: '/tmp/stale.png', order: 5 },
      { kind: 'attachment', source: 'user_attachment', name: 'notes.txt', path: '/tmp/notes.txt', order: 0 },
    ],
  }
  assert.deepEqual(
    resolveOrderedImageReferences(envelope).map((item) => ({ name: item.name, order: item.labelOrder })),
    [{ name: 'first.png', order: 1 }, { name: 'later.png', order: 2 }],
  )
  assert.deepEqual(
    resolveOrderedImageReferences(envelope, [2]).map((item) => item.name),
    ['later.png'],
  )
  assert.throws(() => resolveOrderedImageReferences(envelope, [2, 1]), /从小到大/)
  assert.throws(() => resolveOrderedImageReferences(envelope, [3]), /不存在/)
})

test('service writes generated output to bounded cache then copies it into document assets and folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-image-generation-test-'))
  const cacheRoot = join(root, 'cache')
  const refsRoot = join(root, 'refs')
  const docsRoot = join(root, 'docs')
  const exportRoot = join(root, 'exports')
  await Promise.all([mkdir(cacheRoot), mkdir(refsRoot), mkdir(docsRoot), mkdir(exportRoot)])
  const expiredCacheFile = join(cacheRoot, 'expired.png')
  await writeFile(expiredCacheFile, PNG_BYTES)
  await utimes(expiredCacheFile, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'))
  const firstRef = join(refsRoot, 'first.png')
  const secondRef = join(refsRoot, 'second.png')
  await Promise.all([writeFile(firstRef, PNG_BYTES), writeFile(secondRef, PNG_BYTES)])
  const uploadNames: string[] = []
  const store = {
    getRuntimeService: (id: string) => id === 'gpt-image-test' ? imageServiceConfig() : null,
    getFirstEnabledImageGenerationService: () => imageServiceConfig(),
  }
  const service = new ImageGenerationService({
    store,
    cacheRoot,
    now: () => new Date('2026-07-15T08:09:10.000Z'),
    uuid: () => 'fixed-id',
    client: {
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.ok(init?.body instanceof FormData)
        for (const value of (init.body as FormData).getAll('image[]')) {
          uploadNames.push((value as File).name)
        }
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch,
    },
  })

  try {
    const artifact = await service.generate({
      prompt: 'use only the second labeled reference',
      referenceImageOrders: [2],
      requestEnvelope: {
        resources: [
          { kind: 'attachment', source: 'user_attachment', name: 'second.png', path: secondRef, order: 20 },
          { kind: 'attachment', source: 'explicit_reference', name: 'first.png', path: firstRef, order: 10 },
        ],
      },
    })

    assert.deepEqual(uploadNames, ['second.png'])
    assert.equal(artifact.kind, 'generated_image')
    assert.equal(artifact.meta.temporary, true)
    assert.deepEqual(artifact.meta.referenceImages, [{ order: 2, name: 'second.png' }])
    assert.ok(artifact.path.startsWith(cacheRoot))
    assert.deepEqual(await readFile(artifact.path), PNG_BYTES)
    await assert.rejects(readFile(expiredCacheFile), /ENOENT/)

    const documentPath = join(docsRoot, 'draft.md')
    await writeFile(documentPath, '# Draft')
    const documentCopy = await service.persistToDocument(artifact.path, documentPath)
    assert.equal(documentCopy.relativePath, `assets/${documentCopy.name}`)
    assert.deepEqual(await readFile(documentCopy.path), PNG_BYTES)

    const firstExport = await service.persistToDirectory(artifact.path, exportRoot)
    const secondExport = await service.persistToDirectory(artifact.path, exportRoot)
    assert.notEqual(firstExport.path, secondExport.path)
    assert.deepEqual(await readFile(firstExport.path), PNG_BYTES)

    const outside = join(root, 'outside.png')
    await writeFile(outside, PNG_BYTES)
    await assert.rejects(service.readCachedImage(outside), /Ready 临时生图/)

    const oversized = join(cacheRoot, 'oversized.png')
    await writeFile(oversized, '')
    await truncate(oversized, IMAGE_GENERATION_MAX_OUTPUT_BYTES + 1)
    await assert.rejects(service.readCachedImage(oversized), /32 MB/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
