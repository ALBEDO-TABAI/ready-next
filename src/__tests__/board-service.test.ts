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

test('board saves to the same file are serialized and the newest state wins', async () => {
  await withTempDir(async (dir) => {
    let templateReads = 0
    let releaseFirstSave!: () => void
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve })
    let markFirstSaveStarted!: () => void
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve })
    const board = new ReadyBoardService({
      readTemplate: async () => {
        templateReads += 1
        if (templateReads === 2) {
          markFirstSaveStarted()
          await firstSaveGate
        }
        return createReadyBoardTemplate()
      },
      now: () => new Date('2026-06-15T00:00:00.000Z'),
    })
    const created = await board.create(dir)
    assert.equal(created.success, true, created.error)

    const olderSave = board.save(created.data!.boardId, { ...created.data!.state, title: 'older' })
    await firstSaveStarted
    const newerSave = board.save(created.data!.boardId, { ...created.data!.state, title: 'newer' })
    await Promise.resolve()
    assert.equal(templateReads, 2)
    let reopenSettled = false
    const reopened = board.open(created.data!.path).then((result) => {
      reopenSettled = true
      return result
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(reopenSettled, false)

    releaseFirstSave()
    const [, , reopenedResult] = await Promise.all([olderSave, newerSave, reopened])
    const finalState = extractReadyBoardStateFromHtml(await readFile(created.data!.path, 'utf8'))
    assert.equal(finalState.title, 'newer')
    assert.equal(reopenedResult.data?.state.title, 'newer')
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

test('board:importRemoteImage leaves state ownership to renderer and persists an unacknowledged external receipt', async () => {
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

    board.setActive(created.data!.boardId)
    const appended = await board.importRemoteImageToActiveBoard('https://example.com/active.png')
    assert.equal(appended.success, true, appended.error)
    assert.equal(appended.data?.boardId, created.data!.boardId)
    assert.equal(appended.data?.asset.kind, 'image')
    assert.ok(appended.data?.receiptId)

    const restarted = service([], fetcher)
    const reopened = await restarted.open(created.data!.path)
    assert.equal(reopened.data?.state.nodes.length, 0)
    assert.deepEqual(
      reopened.data?.pendingExternalAssets?.map((receipt) => receipt.id),
      [appended.data?.receiptId],
    )
    const acknowledged = await restarted.acknowledgeExternalAssets(
      reopened.data!.boardId,
      [appended.data!.receiptId],
    )
    assert.equal(acknowledged.data?.acknowledged, 1)
    const verified = await service([], fetcher).open(created.data!.path)
    assert.deepEqual(verified.data?.pendingExternalAssets, [])
  })
})

test('clearing an older board cannot clear a newer active board', async () => {
  await withTempDir(async (dir) => {
    const fetcher: typeof fetch = async () => new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png' },
    })
    const board = service([], fetcher)
    const first = await board.create(dir)
    const second = await board.create(dir)
    board.setActive(second.data!.boardId)
    board.setActive(null, first.data!.boardId)
    const imported = await board.importRemoteImageToActiveBoard('https://example.com/target.png')
    assert.equal(imported.success, true, imported.error)
    assert.equal(imported.data?.boardId, second.data!.boardId)
  })
})

test('opening another board never overrides the board explicitly activated by pane focus', async () => {
  await withTempDir(async (dir) => {
    const fetcher: typeof fetch = async () => new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png' },
    })
    const board = service([], fetcher)
    const focused = await board.create(dir)
    const other = await board.create(dir)
    board.setActive(focused.data!.boardId)
    await board.open(other.data!.path)
    const imported = await board.importRemoteImageToActiveBoard('https://example.com/focused.png')
    assert.equal(imported.success, true, imported.error)
    assert.equal(imported.data?.boardId, focused.data!.boardId)
  })
})

test('reopening the same board reuses its handle instead of growing hidden handles', async () => {
  await withTempDir(async (dir) => {
    const board = service([])
    const created = await board.create(dir)
    const reopened = await board.open(created.data!.path)
    assert.equal(reopened.data?.boardId, created.data?.boardId)
  })
})
