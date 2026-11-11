import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function pdf(text) {
  const stream = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const offset = Buffer.byteLength(body)
  body += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map(n => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  return Buffer.from(body)
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function png() {
  const chunk = (type, data) => {
    const name = Buffer.from(type)
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([head, name, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(8, 0)
  header.writeUInt32BE(8, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.from([0, ...Array.from({ length: 8 }, () => [40, 120, 180]).flat()])
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(8).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const CONTACTS = Array.from({ length: 8 }, (_, i) => ({
  name: ['王明', '李华', '张宁', '赵悦', '陈晨', '刘洋', '周青', '吴桐'][i],
  email: `contact${i + 1}@example.test`,
  company: `示例公司${i + 1}`,
  phone: `1380000000${i + 1}`,
}))
export const MEMBERS = Array.from({ length: 23 }, (_, i) => ({
  id: i + 1,
  name: `会员${String(i + 1).padStart(2, '0')}`,
  plan: i < 9 ? '年费' : '月费',
}))
export const REPORT_ROWS = Object.fromEntries(
  [1, 2, 3].map(q => [
    q,
    ['华东', '华北', '华南'].flatMap((region, r) =>
      Array.from({ length: 3 }, (_, m) => [
        region,
        `2026-${String((q - 1) * 3 + m + 1).padStart(2, '0')}`,
        q === 3 && r === 0 ? [410000, 426450, 450000][m] : q * 100000 + r * 10000 + m * 1234,
      ]),
    ),
  ]),
)
const files = {
  ...Object.fromEntries(
    [1, 2, 3].map(q => [
      `report-2026-q${q}.csv`,
      [
        'text/csv; charset=utf-8',
        Buffer.from(`地区,月份,销售额\n${REPORT_ROWS[q].map(row => row.join(',')).join('\n')}\n`),
      ],
    ]),
  ),
  'manual-s2.pdf': ['application/pdf', pdf('S2-PRO-2026')],
  'eval-receipt.pdf': ['application/pdf', pdf('EVAL RECEIPT 2026-11')],
  'avatar.png': ['image/png', png()],
  'members.json': [
    'application/json; charset=utf-8',
    Buffer.from(JSON.stringify(MEMBERS, null, 2) + '\n'),
  ],
  'contacts.csv': [
    'text/csv; charset=utf-8',
    Buffer.from(
      `姓名,邮箱,公司,电话\n${CONTACTS.map(c => Object.values(c).join(',')).join('\n')}\n`,
    ),
  ],
  'data.json': ['application/json; charset=utf-8', Buffer.from('{"year":2026,"count":27}\n')],
}
export const FIXTURE_FILES = Object.fromEntries(
  Object.entries(files).map(([name, [contentType, buffer]]) => [
    name,
    { name, contentType, bytes: () => Buffer.from(buffer) },
  ]),
)
export function fixtureInfo(name) {
  const file = FIXTURE_FILES[name]
  if (!file) throw new Error(`未知夹具：${name}`)
  const bytes = file.bytes()
  return { name, size: bytes.length, sha256: sha256(bytes), contentType: file.contentType }
}
export async function writeAttachmentFixtures(dir, names = Object.keys(FIXTURE_FILES)) {
  await mkdir(dir, { recursive: true })
  return Promise.all(
    names.map(async name => {
      const info = fixtureInfo(name)
      const path = join(dir, name)
      await writeFile(path, FIXTURE_FILES[name].bytes())
      return { name, path, size: info.size, sha256: info.sha256 }
    }),
  )
}
