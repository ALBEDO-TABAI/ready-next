// Bundled only by verify-ready-next-capture.cjs, never imported by production.
import { captureItem, captureToFastCard, captureToCanvas, captureToDocument, captureAnswerAsPage, dropDocumentReference } from '../../src/renderer/modules/workbench/capture'
import { captureSelectionToAgent } from '../../src/renderer/modules/agent/drop-reference'
import { dropCanvasReference } from '../../src/renderer/modules/canvas/drop-reference'
import { writeReadyRefTransfer, toReadyUri, type ReadyRef } from '../../src/shared/ready-ref'
import { useDocTabs } from '../../src/renderer/stores/useDocTabs'
import { useAgent } from '../../src/renderer/stores/useAgent'
import { getTabBuffer } from '../../src/renderer/modules/document/block-editor/tab-buffer'
import { drafts, useDraftUI, completeDraftSave } from '../../src/renderer/modules/document/drafts/runtime'
import { finalizeDraftTab } from '../../src/renderer/modules/document/drafts/save'
import { readDocumentSource } from '../../src/shared/document-operations'

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
export async function run({ root, bookPath, pdfPath }: { root: string; bookPath: string; pdfPath: string }) {
  const api = window.electronAPI
  const results: Array<{ name: string; destination: string; id?: string; path?: string; text?: string; source: string }> = []
  const page = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '收下目标', content: '原正文', operationId: crypto.randomUUID() })
  check(page.ok, JSON.stringify(page)); const target = page.value
  check(target.path, 'page path missing')
  const initial = await api.document.readFile(target.path)
  const tabId = useDocTabs.getState().createBackgroundTab({ title: '收下目标', path: target.path })
  useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === tabId ? { ...tab, content: initial.content || '', objectId: target.objectId, isDirty: false } : tab) }))
  const savedBoard = await api.canvas.create({ path: '收下画板.canvas', operationId: crypto.randomUUID(), canvas: { ready: { id: crypto.randomUUID(), schemaVersion: 1, title: '收下画板' }, nodes: [], edges: [] } })
  check(savedBoard.ok, JSON.stringify(savedBoard)); let board = savedBoard.value
  const boardTarget = { kind: 'existing' as const, objectId: board.objectId }
  const imported = await api.library.importFiles([bookPath]); check(imported.success, JSON.stringify(imported))
  const library = await api.library.get(); check(library.success, JSON.stringify(library))
  const book = library.data.books.find(book => book.title === '验收书'); check(book, 'book import missing')
  const pdf = await api.objects.resolvePath(pdfPath)
  const selections: Array<[string, ReadyRef, string[]]> = [
    ['网页选区', { kind: 'web', url: 'https://example.invalid/capture' }, ['document']],
    ['资讯文章', { kind: 'rss-item', id: 'capture-article' }, ['fastcard', 'canvas', 'document']],
    ['资讯选区', { kind: 'rss-item', id: 'capture-article' }, ['fastcard', 'canvas', 'document']],
    ['书', { kind: 'book-location', book: book.id, loc: 'c0:0+2' }, ['fastcard', 'canvas']],
    ['划线', { kind: 'book-location', book: book.id, loc: 'c0:2+2' }, ['fastcard', 'canvas']],
    ['PDF选区', { kind: 'file', id: pdf.objectId, anchor: 'pdf:{"page":1}' }, ['fastcard', 'document', 'agent']],
    ['文档块', { kind: 'page', id: target.objectId, anchor: '^capture-block' }, ['canvas']],
    ['助手回答', { kind: 'conversation', id: 'capture-conversation', run: 'capture-run' }, ['canvas', 'page']],
  ]
  const persist = async () => {
    const before = await api.document.readFile(target.path!), content = useDocTabs.getState().tabs.find(tab => tab.id === tabId)!.content
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(before.content)))).map(x => x.toString(16).padStart(2, '0')).join('')
    const saved = await api.documentPages.save({ path: target.path!, content, expectedVersion: digest }); check(saved.ok, JSON.stringify(saved))
    check((await api.document.readFile(target.path!)).content === content, 'document readback differs')
    return content
  }
  for (const [name, ref, destinations] of selections) for (const destination of destinations) {
    const text = name + '的完整原文：第一句，第二句。', selection = { ref, title: name, text }
    if (destination === 'fastcard') {
      const item = await captureToFastCard(captureItem(selection)), all = await api.browser.listFastCardItems()
      const stored = all.data?.find(card => card.id === item.id)
      check(stored?.text === text && stored.source?.ref && toReadyUri(stored.source.ref) === toReadyUri(ref), name + ' provenance mismatch')
      results.push({ name, destination, id: item.id, text, source: toReadyUri(ref) })
    } else if (destination === 'canvas') {
      await captureToCanvas(captureItem(selection), boardTarget)
      const read = await api.canvas.read(board.handleId); check(read.ok, JSON.stringify(read)); board = read.value
      const node = board.canvas.nodes.find(node => node.type === 'text' && node.text === text)
      check(node?.ready.sources?.some(source => source.uri === toReadyUri(ref)), name + ' canvas provenance mismatch')
      results.push({ name, destination, path: root + '/' + board.path, text, source: toReadyUri(ref) })
    } else if (destination === 'document') {
      await captureToDocument(selection, tabId); check((await persist()).includes(text), 'document content missing')
      results.push({ name, destination, path: target.path, text, source: toReadyUri(ref) })
    } else if (destination === 'agent') {
      await captureSelectionToAgent(selection)
      check(useAgent.getState().attachments.some(item => item.path === pdfPath) && useAgent.getState().inputValue.includes(text), 'PDF selection not in composer')
      results.push({ name, destination, source: toReadyUri(ref) })
    } else {
      const pending = captureAnswerAsPage(selection)
      for (let i = 0; i < 200 && !useDraftUI.getState().saveTabId; i++) await new Promise(resolve => setTimeout(resolve, 10))
      const id = useDraftUI.getState().saveTabId; check(id, 'Save To was not requested')
      const saved = await finalizeDraftTab(id, { parentPath: root, title: '助手回答保存', operationId: crypto.randomUUID() })
      completeDraftSave(saved.path); check(await pending === saved.path, 'save completion mismatch')
      const read = await api.document.readFile(saved.path)
      check(readDocumentSource(read.content!).frontmatter.ready_source === toReadyUri(ref), 'ready_source missing')
      results.push({ name, destination, path: saved.path, text, source: toReadyUri(ref) })
    }
  }
  const database = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '验收数据库', database: true, operationId: crypto.randomUUID() })
  check(database.ok, JSON.stringify(database))
  const created = await api.documentDatabase({ type: 'createRow', databaseId: database.value.objectId, title: '验收行', values: {}, body: '行正文', operationId: crypto.randomUUID() })
  check(created.ok, JSON.stringify(created))
  const row = (await api.databasePreview(database.value.objectId)).rows.find(row => row.title === '验收行'); check(row, 'row missing')
  for (const [name, id] of [['文档页面', target.objectId], ['数据库行', row.id]]) {
    const ref: ReadyRef = { kind: 'page', id }, data = new DataTransfer(); writeReadyRefTransfer(data, ref, name)
    await dropCanvasReference(data, { x: 0, y: 0 }, { objectId: board.objectId, root, refresh: async () => {}, write: async commands => {
      const current = await api.canvas.read(board.handleId); check(current.ok, JSON.stringify(current))
      const written = await api.canvas.write({ objectId: board.objectId, handleId: board.handleId, expectedVersion: current.value.version, operationId: crypto.randomUUID(), commands })
      check(written.ok && written.value.state === 'completed', JSON.stringify(written))
    } })
    results.push({ name, destination: 'canvas', path: root + '/' + board.path, source: toReadyUri(ref) })
  }
  for (const image of [false, true]) {
    const card = image ? (await api.browser.listFastCardItems()).data?.find(item => item.id === 'fixture-image')
      : await captureToFastCard(captureItem({ ref: { kind: 'web', url: 'https://example.invalid/fastcard' }, title: 'FastCard', text: 'FastCard原文' }))
    check(card, 'image seed missing')
    const data = new DataTransfer(), ref: ReadyRef = { kind: 'fastcard', id: card.id }, name = image ? '图片FastCard' : 'FastCard'
    writeReadyRefTransfer(data, ref, name)
    await dropDocumentReference(data, getTabBuffer(tabId)); await persist()
    results.push({ name, destination: 'document', path: target.path, source: toReadyUri(ref) })
    await dropCanvasReference(data, { x: 0, y: 0 }, { objectId: board.objectId, root, write: async () => { throw Error('must use FastCard transfer') }, refresh: async () => {} })
    results.push({ name, destination: 'canvas', path: root + '/' + board.path, source: card.source?.ref ? toReadyUri(card.source.ref) : toReadyUri(ref) })
  }
  await drafts.flushAll(); await api.canvas.release(board.handleId)
  return results
}
