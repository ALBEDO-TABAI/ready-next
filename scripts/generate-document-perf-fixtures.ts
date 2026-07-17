import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import JSZip from 'jszip'
import * as XLSX from 'xlsx'

import {
  buildReadyBoardHtml,
  createEmptyReadyBoardState,
  type ReadyBoardNode,
} from '../src/shared/ready-board'

const DEFAULT_OUTPUT = join(tmpdir(), 'ready-document-perf-fixtures')

function readOutputArgument(): string {
  const index = process.argv.indexOf('--output')
  if (index === -1 || !process.argv[index + 1]) return DEFAULT_OUTPUT
  return resolve(process.argv[index + 1])
}

function buildBlankPdf(pageCount: number): Buffer {
  const objects: string[] = []
  const pageObjectIds = Array.from({ length: pageCount }, (_, index) => index + 3)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  for (const id of pageObjectIds) {
    objects[id] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'
  }

  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets: number[] = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'binary')
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'binary')
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'binary')
}

function buildLongMarkdown(): string {
  const lines: string[] = ['# Ready 文档性能基准', '']
  for (let block = 0; block < 50; block += 1) {
    lines.push(`## 图文块 ${block + 1}`)
    lines.push(`![图文块 ${block + 1}](./images/image-${String(block + 1).padStart(2, '0')}.svg)`)
    lines.push(`这是第 ${block + 1} 个图文块，用于验证长文档滚动、图片晚到与块级渲染。`)
    lines.push('')
  }
  for (let widget = 0; widget < 20; widget += 1) {
    lines.push('```show-widget')
    lines.push(JSON.stringify({
      id: `perf-widget-${widget + 1}`,
      title: `性能卡片 ${widget + 1}`,
      widgetCode: `<section style="padding:16px"><strong>Widget ${widget + 1}</strong><p>稳定内容</p></section>`,
    }))
    lines.push('```', '')
  }
  while (lines.length < 5_000) {
    const line = lines.length + 1
    lines.push(`第 ${line} 行基准正文：持续输入时不应同步重建大纲、扫描卡片或重启滚动恢复。`)
  }
  return `${lines.slice(0, 5_000).join('\n')}\n`
}

function buildBoardNodes(): ReadyBoardNode[] {
  return Array.from({ length: 150 }, (_, index) => ({
    id: `perf-node-${index + 1}`,
    type: 'note' as const,
    x: (index % 15) * 220,
    y: Math.floor(index / 15) * 150,
    width: 190,
    height: 120,
    text: `性能节点 ${index + 1}`,
    color: '#1f2937',
    background: index % 2 === 0 ? '#fef3c7' : '#dbeafe',
  }))
}

async function buildDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Ready packaged document worker proof</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function buildXlsx(): Buffer {
  const workbook = XLSX.utils.book_new()
  const rows = Array.from({ length: 2_000 }, (_, index) => [
    index + 1,
    `Ready row ${index + 1}`,
    (index + 1) * 3,
  ])
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['index', 'label', 'value'],
    ...rows,
  ]), 'Performance')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

async function buildEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.folder('META-INF')?.file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  const oebps = zip.folder('OEBPS')
  oebps?.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">ready-perf</dc:identifier><dc:title>Ready Performance EPUB</dc:title><dc:language>zh-CN</dc:language></metadata>
  <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="chapter"/></spine>
</package>`)
  oebps?.file('chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ready Performance EPUB</title></head><body><h1>Ready Performance EPUB</h1><p>${'packaged worker proof '.repeat(5_000)}</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function main(): Promise<void> {
  const outputDir = readOutputArgument()
  if (outputDir === DEFAULT_OUTPUT) {
    await rm(outputDir, { recursive: true, force: true })
  }
  const imageDir = join(outputDir, 'images')
  await mkdir(imageDir, { recursive: true })

  for (let index = 0; index < 50; index += 1) {
    const label = String(index + 1).padStart(2, '0')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="100%" height="100%" fill="#${index % 2 === 0 ? 'dbeafe' : 'fef3c7'}"/><text x="60" y="110" font-size="54" fill="#1f2937">Ready image ${label}</text></svg>`
    await writeFile(join(imageDir, `image-${label}.svg`), svg)
  }

  const board = createEmptyReadyBoardState('150 节点性能画布')
  board.nodes = buildBoardNodes()
  board.updatedAt = new Date(0).toISOString()
  const secondaryBoard = createEmptyReadyBoardState('第二画布')
  secondaryBoard.nodes = buildBoardNodes().slice(0, 30).map((node, index) => ({
    ...node,
    id: `secondary-node-${index + 1}`,
    text: `第二画布节点 ${index + 1}`,
  }))
  secondaryBoard.updatedAt = new Date(0).toISOString()

  const files = {
    markdown: 'long-rich-document.md',
    secondaryMarkdown: 'secondary-document.md',
    board: 'large-board.readyboard',
    secondaryBoard: 'secondary-board.readyboard',
    pdf: '500-pages.pdf',
    docx: 'worker-proof.docx',
    xlsx: 'worker-proof.xlsx',
    epub: 'worker-proof.epub',
  }
  const [docx, epub] = await Promise.all([buildDocx(), buildEpub()])
  await Promise.all([
    writeFile(join(outputDir, files.markdown), buildLongMarkdown()),
    writeFile(join(outputDir, files.secondaryMarkdown), '# 第二文档\n\n用于双栏保存、焦点与外部变更保护验收。\n'),
    writeFile(join(outputDir, files.board), buildReadyBoardHtml(board)),
    writeFile(join(outputDir, files.secondaryBoard), buildReadyBoardHtml(secondaryBoard)),
    writeFile(join(outputDir, files.pdf), buildBlankPdf(500)),
    writeFile(join(outputDir, files.docx), docx),
    writeFile(join(outputDir, files.xlsx), buildXlsx()),
    writeFile(join(outputDir, files.epub), epub),
    writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date(0).toISOString(),
      outputDir,
      files,
      counts: {
        lines: 5_000,
        imageBlocks: 50,
        widgets: 20,
        boards: 2,
        boardNodes: [150, 30],
        pdfPages: 500,
        workerFormats: 3,
      },
    }, null, 2)}\n`),
  ])
  process.stdout.write(`${outputDir}\n`)
}

await main()
