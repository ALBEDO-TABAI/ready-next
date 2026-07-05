import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const INDEX_REL = 'src/renderer/styles/index.css'
const SECTION_BANNER_PREFIX = '/* ═══'

/**
 * index.css 于 2026-07-06 按领域序保拆分（@import 列表 + 十个段落文件，
 * 打包产物逐字节一致）。样式合同的断言语料通过本读取器重建：内联全部
 * 本地段落 @import（剥掉各文件首行拆分横幅、跳过 index 的拆分说明注释），
 * 得到与拆分前单文件语料同构的字符串——既有断言零改写。
 *
 * 新写的样式合同优先直接读对应段落文件（更紧的锚），只有跨段断言才用本函数。
 */
export function readRendererStyles(): string {
  const abs = resolve(process.cwd(), INDEX_REL)
  const dir = dirname(abs)
  const out: string[] = []
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    const local = line.match(/^@import '\.\/([^']+\.css)';$/)
    if (local && local[1] !== 'tiptap.css') {
      const body = readFileSync(join(dir, local[1]), 'utf8').split('\n')
      if (body[0]?.startsWith(SECTION_BANNER_PREFIX)) body.shift()
      out.push(body.join('\n'))
      continue
    }
    if (line.startsWith('/* index.css 已按领域') || line.startsWith('   级联语义')) {
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}
