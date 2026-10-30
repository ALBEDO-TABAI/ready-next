import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ON = 'READY_BOOK_SOURCE_BUILD_CTFILE_ON'
const OFF = 'READY_BOOK_SOURCE_BUILD_CTFILE_OFF'
const sentinels = ['READY_OPTIONAL_CTFILE_IMPLEMENTATION_V1', 'READY_OPTIONAL_TREASURE_IMPLEMENTATION_V1']
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`产物中不能有符号链接：${entry.name}`)
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
export function inspectBookSourceBuild(root) {
  if (!statSync(root).isDirectory()) throw new Error('缺少构建产物目录')
  const artifacts = files(root)
  const main = artifacts.filter(path => /[/\\]main[/\\].*\.(js|cjs|mjs)$/.test(path))
  if (!main.length) throw new Error('缺少 Main 构建产物')
  const mainText = main.map(path => readFileSync(path, 'utf8')).join('\n')
  if (mainText.includes(ON) === mainText.includes(OFF)) throw new Error('书源构建标记缺失或互相矛盾')
  const ctfile = mainText.includes(ON)
  const text = artifacts.filter(path => /\.(js|cjs|mjs|json|map|html)$/.test(path)).map(path => readFileSync(path, 'utf8')).join('\n')
  const found = sentinels.filter(sentinel => text.includes(sentinel))
  if (ctfile && found.length !== sentinels.length) throw new Error('开启构建缺少书源模块')
  if (!ctfile && (found.length || /ctfile\.com|ebook-treasure-chest/.test(text))) throw new Error('关闭构建仍包含额外书源代码')
  return { ctfile, files: artifacts.length }
}
export function verifyExcluded(root) {
  const result = inspectBookSourceBuild(root)
  if (result.ctfile) throw new Error('此检查要求关闭 ctfile；开启版本不能作为发布排除证据')
  if (!files(root).some(path => /[/\\]renderer[/\\].*\.html$/.test(path))) throw new Error('缺少 Renderer 构建产物')
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = verifyExcluded(resolve(process.argv[2] || 'out'))
    console.log(`[ctfile-excluded] PASS — ctfile=false; ${result.files} 个产物文件，无额外书源代码`)
  } catch (error) { console.error(`[ctfile-excluded] FAIL — ${error.message}`); process.exitCode = 1 }
}
