import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { ReadyBoardService } from '../main/modules/board-engine/board-service'
import {
  createReadyBoardTemplate,
  extractReadyBoardStateFromHtml,
  type ReadyBoardState,
} from '../shared/ready-board'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

async function withTempDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ready-board-service-'))
  try {
    await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function service(changedPaths: string[] = [], fetcher?: typeof fetch): ReadyBoardService {
  return new ReadyBoardService({
    readTemplate: async () => createReadyBoardTemplate(),
    now: () => new Date('2026-06-15T00:00:00.000Z'),
    fetch: fetcher,
    onDirectoryChanged: (paths) => changedPaths.push(...paths),
  })
}

test('board:create writes a self-contained board file and registers a handle', async () => {
  await withTempDir(async (dir) => {
    const realDir = await realpath(dir)
    const changed: string[] = []
    const result = await service(changed).create(dir)

    assert.equal(result.success, true, result.error)
    assert.ok(result.data?.boardId)
    assert.equal(result.data?.path, join(realDir, '画板.readyboard'))
    assert.equal(existsSync(result.data!.path), true)
    assert.deepEqual(changed, [realDir])
  })
})

test('board:save uses the handle path and safely roundtrips state', async () => {
  await withTempDir(async (dir) => {
    const board = service()
    const created = await board.create(dir)
    assert.equal(created.success, true, created.error)

    const state: ReadyBoardState = {
      ...created.data!.state,
      title: 'unsafe </script><!--',
      nodes: [{
        id: 'note',
        type: 'note',
        text: 'unsafe </script><!-- \u2028',
        x: 10,
        y: 20,
        width: 120,
        height: 80,
        color: '#111',
        background: '#fff4b8',
      }],
    }
    const saved = await board.save(created.data!.boardId, state)
    assert.equal(saved.success, true, saved.error)

    const html = await readFile(created.data!.path, 'utf8')
    const script = html.match(/<script[^>]*id=["']ready-board-state["'][^>]*>([\s\S]*?)<\/script>/i)?.[1] || ''
    assert.equal(script.includes('</script>'), false)
    assert.equal(script.includes('<!--'), false)
    assert.match(script, /\\u003C\/script\\u003E/)

    const reopened = extractReadyBoardStateFromHtml(html)
    assert.equal(reopened.title, state.title)
    assert.equal(reopened.nodes.length, 1)
  })
})

test('board service rejects forged handles and non-board opens', async () => {
  await withTempDir(async (dir) => {
    const board = service()
    const save = await board.save('missing', { nodes: [] })
    assert.equal(save.success, false)
    assert.equal(save.errorCode, 'BOARD_HANDLE_NOT_FOUND')

    const ordinaryHtml = join(dir, 'page.html')
    await writeFile(ordinaryHtml, '<html></html>')
    const opened = await board.open(ordinaryHtml)
    assert.equal(opened.success, false)
    assert.equal(opened.errorCode, 'NOT_BOARD_FILE')
  })
})

test('board:importAsset validates image content and de-duplicates by content hash', async () => {
  await withTempDir(async (dir) => {
    const board = service()
    const created = await board.create(dir)
    assert.equal(created.success, true, created.error)

    const source = join(dir, 'source.png')
    await writeFile(source, PNG_BYTES)
    const first = await board.importAsset(created.data!.boardId, source, 'image')
    const second = await board.importAsset(created.data!.boardId, source, 'image')
    assert.equal(first.success, true, first.error)
    assert.equal(second.success, true, second.error)
    assert.equal(first.data?.src, second.data?.src)
    assert.equal(first.data?.src.startsWith('assets/'), true)
    assert.equal(existsSync(join(dir, first.data!.src)), true)

    const bad = join(dir, 'bad.png')
    await writeFile(bad, 'not an image')
    const rejected = await board.importAsset(created.data!.boardId, bad, 'image')
    assert.equal(rejected.success, false)
    assert.equal(rejected.errorCode, 'ASSET_IMPORT_FAILED')

    const assetStat = await stat(join(dir, first.data!.src))
    assert.equal(assetStat.size, PNG_BYTES.length)
  })
})

test('board:openInDocument resolves only board asset paths', async () => {
  await withTempDir(async (dir) => {
    const board = service()
    const created = await board.create(dir)
    assert.equal(created.success, true, created.error)

    const source = join(dir, 'source.png')
    await writeFile(source, PNG_BYTES)
    const asset = await board.importAsset(created.data!.boardId, source, 'image')
    assert.equal(asset.success, true, asset.error)

    const opened = await board.openInDocument(created.data!.boardId, asset.data!.src)
    assert.equal(opened.success, true, opened.error)
    assert.equal(opened.data?.path, join(await realpath(dir), asset.data!.src))

    const escaped = await board.openInDocument(created.data!.boardId, '../outside.md')
    assert.equal(escaped.success, false)
  })
})

test('board:importRemoteImage stores remote images and active board appends a node', async () => {
  await withTempDir(async (dir) => {
    const fetcher: typeof fetch = async () => new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png' },
    })
    const board = service([], fetcher)
    const created = await board.create(dir)
    assert.equal(created.success, true, created.error)

    const imported = await board.importRemoteImage(created.data!.boardId, 'https://example.com/reference.png')
    assert.equal(imported.success, true, imported.error)
    assert.equal(imported.data?.kind, 'image')
    assert.equal(imported.data?.src.startsWith('assets/'), true)
    assert.equal(existsSync(join(await realpath(dir), imported.data!.src)), true)

    const appended = await board.addRemoteImageToActiveBoard('https://example.com/active.png')
    assert.equal(appended.success, true, appended.error)
    assert.equal(appended.data?.state.nodes.length, 1)
    assert.equal(appended.data?.state.nodes[0]?.type, 'image')
  })
})
