// 容忍全半角、常见实体、HTML/粗体标记、千分位、区间符号与空白差异。
export function normalizeText(text = '') {
  return text
    .normalize('NFKC')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
    .replace(/[–—~至到]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}
// 统一转成布尔结果；不额外放宽条件。
export const check = (id, pass, detail) => ({
  id,
  pass: Boolean(pass),
  ...(detail ? { detail } : {}),
})
// 所有检查均通过才通过；空检查列表不算通过。
export const result = checks => ({ pass: checks.length > 0 && checks.every(c => c.pass), checks })
// 只读取指定记录名的数据，不接受其他记录代替。
export const recordsOf = (outcome, kind) =>
  outcome.records.filter(record => record.kind === kind).map(record => record.data)
// 容忍文本规范化差异；数字两侧不能紧接数字或小数点。
export const number = (text, n) =>
  new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}(?![\\d.])`).test(normalizeText(text))
// 忽略规范化后的空白，再检查完整目标文本是否出现。
export const includes = (text, value) =>
  normalizeText(text).replace(/\s/g, '').includes(normalizeText(value).replace(/\s/g, ''))
// 忽略规范化后的空白，其他文本必须相等。
export const equalText = (a, b) =>
  normalizeText(a).replace(/\s/g, '') === normalizeText(b).replace(/\s/g, '')
// 容忍末尾斜线、常见标点和 &amp;；端口、路径、查询与 hash 必须一致。
export function hasUrl(text, expected) {
  const urls = text.replace(/&amp;/g, '&').match(/https?:\/\/[^\s<>"'\]）)]+/g) || []
  const canonical = value => {
    try {
      const url = new URL(value.replace(/[，。；,;]+$/, ''))
      url.pathname = url.pathname.replace(/\/$/, '') || '/'
      return `${url.origin}${url.pathname}${url.search}${url.hash}`
    } catch {
      return ''
    }
  }
  return urls.some(url => canonical(url) === canonical(expected))
}
// 容忍文件名和文档格式差异；全部内容检查必须落在同一资料库文档。
export function findBestDocument(outcome, contentChecks) {
  const documents = outcome.files.filter(
    file =>
      file.root === 'workspace' &&
      /\.(md|markdown|txt|html|htm)$/i.test(file.path) &&
      typeof file.text === 'string',
  )
  let best = null
  for (const file of documents) {
    const checks = contentChecks(file.text)
    const score = checks.filter(c => c.pass).length
    if (!best || score > best.score) best = { file, checks, score }
  }
  return [
    check('document', Boolean(best), best?.file.path),
    ...(best ? best.checks : contentChecks('')),
  ]
}
// 合并单篇文档与额外检查，不允许拼接多篇文档凑齐答案。
export const documentJudge = (outcome, contentChecks, extra = []) =>
  result([...findBestDocument(outcome, contentChecks), ...extra])
// 按指定来源构造地址，默认主站，不做来源替换。
export const source = (outcome, path, origin = 'main') =>
  new URL(path, outcome.origins[origin]).href
// 只检查要求的字段；字符串容忍文本格式差异，其他值严格相等。
export function matches(data, expected) {
  return (
    data &&
    Object.entries(expected).every(([key, value]) =>
      typeof value === 'string' ? equalText(data[key] ?? '', value) : data[key] === value,
    )
  )
}
// 容忍行顺序差异；行数、重复次数和每行内容必须一致。
export function sameRows(actual, expected) {
  const key = row => JSON.stringify(row)
  const expectedKeys = expected.map(key).sort()
  return (
    actual.length === expected.length &&
    actual
      .map(key)
      .sort()
      .every((row, i) => row === expectedKeys[i])
  )
}
// 容忍 BOM、换行、字段尾空白和 CSV 引号转义；无效引号返回 null。
export function parseCsv(text) {
  if (typeof text !== 'string') return null
  const rows = []
  let row = []
  let value = ''
  let quoted = false
  const input = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimEnd()
  for (let i = 0; i <= input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"'
        i++
      } else if (!quoted && value) return null
      else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n' || char === undefined)) {
      row.push(value.trimEnd())
      value = ''
      if (char !== ',') {
        rows.push(row)
        row = []
      }
    } else if (char !== undefined) value += char
  }
  return quoted ? null : rows
}
