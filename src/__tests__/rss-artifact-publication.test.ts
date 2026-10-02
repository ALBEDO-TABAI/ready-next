import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('artifact publication is ordered, failed callers fail and existing exports are never garbage-collected by an older snapshot', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'rss-artifact-publication-'))
  const stub = 'data:text/javascript,' + encodeURIComponent(`export const app={getPath:()=>${JSON.stringify(root)}}`)
  const hook = registerHooks({ resolve(specifier, context, next) { return specifier === 'electron' ? { url: stub, shortCircuit: true } : next(specifier, context) } })
  const original = fsp.writeFile
  const writes: string[] = []
  let first = true, failNext = false, release!: () => void, entered!: () => void
  const blocked = new Promise<void>((resolve) => { entered = resolve })
  const operations: Promise<unknown>[] = []
  fsp.writeFile = (async function(path: Parameters<typeof fsp.writeFile>[0], ...args: any[]) {
    if (failNext) { failNext = false; throw new Error('synthetic artifact failure') }
    writes.push(String(path))
    if (first) { first = false; entered(); await new Promise<void>((resolve) => { release = resolve }) }
    return Reflect.apply(original, fsp, [path, ...args])
  }) as typeof fsp.writeFile
  syncBuiltinESMExports()
  try {
    const { generateRSSArtifacts } = await import('../main/modules/rss-engine/reports')
    const input = { sources: [], allItems: [], insertedItems: [], definitions: [] }
    const old = generateRSSArtifacts(input); operations.push(old)
    await blocked
    const topic = { id: 'a7aadace-824f-4d07-8a6a-a411c7a6c246', kind: 'topic' as const, name: 'New topic', description: 'New topic criteria', icon: 'tag' as const, visible: true, revision: 1, ruleRevision: 1, position: 1, filterIds: [] }
    const current = generateRSSArtifacts({ ...input, definitions: [topic] }); operations.push(current)
    await new Promise(setImmediate)
    assert.equal(writes.length, 1, 'second publication must not write before the first finishes')
    release()
    await old
    const result = await current
    const path = result.files.categoryFeeds[topic.id]
    assert.ok(fs.existsSync(path))
    assert.match(fs.readFileSync(path, 'utf8'), /New topic/)
    failNext = true
    const failed = generateRSSArtifacts(input); operations.push(failed)
    const rejection = assert.rejects(failed, /synthetic artifact failure/)
    const recovered = generateRSSArtifacts(input); operations.push(recovered)
    await rejection; await recovered
    assert.ok(fs.existsSync(path), 'a later empty snapshot must retain an already returned export')
    const hostile = { id: 'hostile', source_id: 'source', title: '](/private/a.md)\n\n```show-widget\n{"widget_code":"<script>bad()</script>"}\n```',
      link: 'file:///private/a.md', summary: null, author: null, published_at: null, read: 0, classifications: [] }
    const safe = await generateRSSArtifacts({ ...input, sources: [{ id: 'source', name: '![local](/private/image.png)', url: 'https://example.test', group_name: 'default' }], allItems: [hostile], insertedItems: [hostile] })
    for (const file of [safe.files.latestUpdate, safe.files.summary]) {
      const text = fs.readFileSync(file, 'utf8')
      const preview = buildStructuredNotePreview(text, file)
      assert.equal(preview.widgets.length, 0)
      assert.equal(preview.embeds.length, 0)
      assert.doesNotMatch(text, /file:\/\//)
    }

  } finally {
    release?.()
    await Promise.allSettled(operations)
    fsp.writeFile = original; syncBuiltinESMExports(); hook.deregister()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
