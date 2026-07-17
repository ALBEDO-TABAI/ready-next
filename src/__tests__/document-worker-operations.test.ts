import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

import {
  DocumentWorkerBridge,
  type DocumentWorkerLike,
} from '../main/modules/document-engine/document-worker-bridge'
import { getDocxOverwriteBlockReason } from '../main/modules/document-engine/document-worker-operations'

test('DOCX overwrite guard evaluates one previous-text snapshot for empty and suspicious shrink saves', () => {
  assert.match(getDocxOverwriteBlockReason('existing body', '') || '', /空内容/)
  assert.match(getDocxOverwriteBlockReason('a'.repeat(1_000), 'short') || '', /极短内容/)
  assert.equal(getDocxOverwriteBlockReason('short body', 'replacement body'), null)
})

function createSourceDocumentWorker(): DocumentWorkerLike {
  const tsxApiUrl = import.meta.resolve('tsx/esm/api')
  const workerModuleUrl = new URL('../main/modules/document-engine/document-worker.ts', import.meta.url).href
  const bootstrap = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(workerModuleUrl)}, import.meta.url);`,
  ].join('\n')
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    type: 'module',
  }) as unknown as DocumentWorkerLike
}

async function writeMinimalEpub(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
    </container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Worker Book</dc:title></metadata>
      <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest>
      <spine><itemref idref="chapter" /></spine>
    </package>`)
  zip.file('OEBPS/chapter.xhtml', '<html><body><h1>Worker chapter</h1><p>Imported away from the main thread.</p></body></html>')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

function buildBlankPdf(pageCount: number): Buffer {
  const objects: string[] = []
  const pageIds = Array.from({ length: pageCount }, (_, index) => index + 3)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  for (const id of pageIds) objects[id] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body)
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

test('real document worker handles DOCX, XLSX, and EPUB without blocking the caller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-document-worker-'))
  const docxPath = join(directory, 'worker.docx')
  const xlsxPath = join(directory, 'worker.xlsx')
  const epubPath = join(directory, 'worker.epub')
  const pdfPath = join(directory, 'worker.pdf')
  const damagedDocxPath = join(directory, 'damaged.docx')
  const bridge = new DocumentWorkerBridge(createSourceDocumentWorker, 60_000)

  try {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['name', 'value'],
        ...Array.from({ length: 2_000 }, (_, index) => [`row-${index}`, index]),
      ]),
      'Rows',
    )
    await writeFile(xlsxPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    await writeMinimalEpub(epubPath)
    await writeFile(pdfPath, buildBlankPdf(2))
    await writeFile(damagedDocxPath, 'Readable text recovered from a damaged DOCX attachment.\nSecond line.')

    let callerTicks = 0
    const ticker = setInterval(() => { callerTicks += 1 }, 2)
    const writePromise = bridge.writeDocx(
      docxPath,
      ['# Worker document', ...Array.from({ length: 3_000 }, (_, index) => `Paragraph ${index}`)].join('\n'),
    )
    const orderedReadPromise = bridge.readDocxText(docxPath)
    const writeResult = await writePromise
    clearInterval(ticker)

    assert.deepEqual(writeResult, { success: true })
    assert.ok(callerTicks > 0, 'the caller event loop should keep advancing during DOCX packing')
    const orderedRead = await orderedReadPromise
    assert.equal(orderedRead.success, true, 'worker requests should preserve order instead of racing the same file')
    assert.match(orderedRead.content, /Paragraph 2999/)

    const [docx, xlsx, rawText, extractedDocx, extractedXlsx, extractedPdf, extractedDamagedDocx, epub] = await Promise.all([
      bridge.parseDocx(docxPath),
      bridge.parseXlsx(xlsxPath),
      bridge.readDocxText(docxPath),
      bridge.extractDocumentText(docxPath, { offset: 10, maxChars: 80 }),
      bridge.extractDocumentText(xlsxPath, { maxSheets: 1, maxRowsPerSheet: 3, maxColumns: 2 }),
      bridge.extractDocumentText(pdfPath, { maxChars: 120 }),
      bridge.extractDocumentText(damagedDocxPath, { maxChars: 120 }),
      bridge.importEpub(epubPath),
    ])
    assert.equal(docx.success, true)
    assert.match(String(docx.content), /Worker document/)
    assert.equal(xlsx.success, true)
    assert.deepEqual(xlsx.sheets, ['Rows'])
    assert.equal((xlsx.sheetData as Record<string, unknown[][]>).Rows.length, 2_001)
    assert.equal(rawText.success, true)
    assert.match(rawText.content, /Paragraph 2999/)
    assert.equal(extractedDocx.success, true)
    assert.equal(extractedDocx.truncated, true)
    assert.equal(extractedDocx.offset, 10)
    assert.equal(extractedDocx.text, rawText.content.slice(10, 90))
    assert.equal(extractedDocx.nextOffset, 90)
    assert.equal(extractedXlsx.success, true)
    assert.match(extractedXlsx.text, /row-1\t1/)
    assert.doesNotMatch(extractedXlsx.text, /row-3/)
    assert.equal(extractedPdf.success, true)
    assert.equal(extractedPdf.kind, 'pdf')
    assert.match(extractedPdf.text, /Page \(0\) Break/)
    assert.equal(extractedDamagedDocx.success, true)
    assert.match(extractedDamagedDocx.text, /Readable text recovered/)
    assert.match(extractedDamagedDocx.warning || '', /回退/)
    assert.equal(epub.success, true)
    const epubMarkdown = await readFile(String(epub.indexPath), 'utf8')
    assert.match(epubMarkdown, /Worker chapter/)
  } finally {
    await bridge.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
