#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')
const { parse: parseHtml } = require('parse5')
const { minimatch } = require('minimatch')

const METRICS = ['color', 'backdropFilter', 'fontFace']
const RETIRED = ['data-skin', 'data-glass-variant', 'data-glass-backdrop', 'data-accent', 'ThemeAccent', 'ThemeSkin', 'ready-theme-accent', 'ready-theme-skin', 'accentPalettes', 'setAccent']
const blank = text => text.replace(/[^\r\n]/g, ' ')
const slash = file => file.split(path.sep).join('/')
const emptyCounts = () => Object.fromEntries(METRICS.map(key => [key, 0]))
const inactive = value => /^(none|initial|unset|inherit)(?:\s*!important)?$/i.test(value.trim())

// Defaults apply only to first creation; an existing file is always a ceiling.
function initialBudget() {
  return {
    directories: {}, retired: {}, retiredAllowFiles: [],
    whitelist: [
      { glob: 'src/renderer/design/next/**', reason: 'W1 §3.1 的共享设计令牌来源。' },
      { glob: 'src/renderer/modules/calendar/workbench/styles/tokens.css', reason: 'W1 §3.2 指定保留的日历明暗色板；文件同时含界面颜色，后续迁移仍需移走这些值。' },
      { glob: 'src/renderer/modules/calendar/workbench/geometry-tokens.ts', reason: '日历生成的明暗颜色数据，与 tokens.css 同源；也混有界面颜色和几何数据。' },
      { glob: 'src/renderer/components/document/EditorFloatingToolbar.tsx', reason: 'TEXT_COLORS / BG_COLORS 是用户正文和高亮色板；按文件白名单也会豁免该文件的界面颜色。' },
      { glob: 'src/renderer/modules/library/reader/marks.ts', reason: 'MARKERS / markerColor 定义用户阅读划线颜色。' },
      { glob: 'src/renderer/modules/library/topics.ts', reason: 'lookOf 生成书脊布色与配套前景色；布色色板本体在扫描范围外的 src/shared/library-topics.ts。' },
    ],
    goals: { color: '模块样式颜色字面量为 0', backdropFilter: '只在材质文件', fontFace: '只在 src/renderer/design/next/tokens.css', retired: '全部为 0' },
  }
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.name === '__tests__' || /\.test\.|\.d\.ts$/.test(entry.name)) return []
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : []
  })
}

function cssWithoutComments(text) {
  return text.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g,
    match => match.startsWith('/*') ? blank(match) : match)
}

function colors(text, offset, add) {
  // Keep offsets while excluding URL fragments, entities and selector hashes.
  const value = cssWithoutComments(text).replace(/url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)])*\)|(?:https?:|file:|data:|\/\/)[^\s"'<>]+|&#(?:x[\da-f]+|\d+);/gi, blank)
  const pattern = /(?<![\w&#/.-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi
  for (const match of value.matchAll(pattern)) {
    const rest = value.slice(match.index + match[0].length)
    if (match[0][0] === '#' ? /^\s*[{.:[>]/.test(rest) : /^\s*var\s*\(/i.test(rest)) continue
    add('color', offset + match.index)
  }
}

function scanCss(text, offset, add) {
  const clean = cssWithoutComments(text)
  // Count declarations, not selector grammar: existing malformed selectors must
  // not turn this budget into a separate CSS syntax gate.
  let start = 0, quote = '', parens = 0
  function declaration(end) {
    const segment = clean.slice(start, end)
    const match = segment.match(/^\s*(--[\w-]+|[a-z-]+)\s*:\s*/i)
    if (!match) return
    const value = segment.slice(match[0].length)
    colors(value, offset + start + match[0].length, add)
    if (/^(?:-webkit-)?backdrop-filter$/i.test(match[1]) && !inactive(value)) add('backdropFilter', offset + start + segment.indexOf(match[1]))
  }
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]
    if (char === '\\') { i++; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') parens++
    if (char === ')') parens--
    if (char === '{') {
      const header = clean.slice(start, i)
      const font = header.match(/^\s*@font-face\b/i)
      if (font) add('fontFace', offset + start + header.indexOf('@'))
      start = i + 1; parens = 0
    } else if (char === '}' || (char === ';' && parens === 0)) {
      declaration(i)
      start = i + 1; parens = 0
    }
  }
  declaration(clean.length)
  return clean
}

function scanScript(text, file, offset, add) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(source) + 1
      const end = node.end - (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1)
      const value = text.slice(start, end)
      const parent = node.parent
      const attribute = ts.isJsxAttribute(parent) ? parent.name.getText(source) : ''
      const selector = ts.isCallExpression(parent) && /(?:querySelector(?:All)?|getElementById)$/.test(parent.expression.getText(source))
      if (!selector && !/^(id|href|src)$/.test(attribute)) colors(value, offset + start, add)
      const clean = cssWithoutComments(value)
      for (const match of clean.matchAll(/@font-face\b/g)) add('fontFace', offset + start + match.index)
      for (const match of clean.matchAll(/(?:^|[;{])\s*((?:-webkit-)?backdrop-filter)\s*:\s*([^;}]+)/gi)) {
        if (!inactive(match[2])) add('backdropFilter', offset + start + match.index + match[0].indexOf(match[1]))
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name
      const key = ts.isStringLiteralLike(name) || ts.isIdentifier(name) ? name.text : ''
      if (/^(backdropFilter|WebkitBackdropFilter)$/.test(key)) {
        const value = ts.isStringLiteralLike(node.initializer) ? node.initializer.text : node.initializer.getText(source)
        if (!inactive(value)) add('backdropFilter', offset + node.name.getStart(source))
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = ts.isPropertyAccessExpression(node.left) ? node.left.name : ts.isElementAccessExpression(node.left) ? node.left.argumentExpression : null
      if (name && /^(backdropFilter|WebkitBackdropFilter)$/.test(name.text)) {
        const value = ts.isStringLiteralLike(node.right) ? node.right.text : node.right.getText(source)
        if (!inactive(value)) add('backdropFilter', offset + name.getStart(source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // Parser token spans omit comments without confusing URLs, regexes, JSX or templates.
  const chunks = []
  let end = 0
  function tokens(node) {
    const children = node.getChildren(source)
    if (children.length) return children.forEach(tokens)
    const start = node.getStart(source)
    chunks.push(blank(text.slice(end, start)), text.slice(start, node.end))
    end = node.end
  }
  tokens(source)
  chunks.push(blank(text.slice(end)))
  return chunks.join('')
}

function scanHtml(text, add) {
  const tree = parseHtml(text, { sourceCodeLocationInfo: true })
  const replacements = []
  function visit(node) {
    const loc = node.sourceCodeLocation
    if (node.nodeName === '#comment' && loc) replacements.push([loc.startOffset, loc.endOffset, blank(text.slice(loc.startOffset, loc.endOffset))])
    if ((node.tagName === 'style' || node.tagName === 'script') && loc?.endTag) {
      const start = loc.startTag.endOffset, end = loc.endTag.startOffset
      const body = text.slice(start, end)
      replacements.push([start, end, node.tagName === 'style' ? scanCss(body, start, add) : scanScript(body, 'inline.js', start, add)])
    }
    for (const attr of node.attrs || []) {
      if (attr.name !== 'style') continue
      const attrLoc = loc.attrs[attr.name]
      const raw = text.slice(attrLoc.startOffset, attrLoc.endOffset)
      const prefix = raw.match(/^style\s*=\s*["']?/i)[0].length
      const body = raw.slice(prefix).replace(/["']$/, '')
      scanCss(body, attrLoc.startOffset + prefix, add)
    }
    for (const child of node.childNodes || []) visit(child)
    if (node.content) visit(node.content)
  }
  visit(tree)
  let clean = text
  for (const [start, end, replacement] of replacements.sort((a, b) => b[0] - a[0])) clean = clean.slice(0, start) + replacement + clean.slice(end)
  return clean
}

function scan(root, budget) {
  const directories = {}, retired = Object.fromEntries(RETIRED.map(key => [key, 0])), locations = []
  for (const absolute of filesUnder(path.join(root, 'src'))) {
    const bytes = fs.readFileSync(absolute)
    if (bytes.includes(0)) continue // binary assets
    const text = bytes.toString('utf8'), file = slash(path.relative(root, absolute)), ext = path.extname(file)
    const renderer = file.startsWith('src/renderer/') && /\.(css|[jt]sx?|html)$/.test(file)
    const directory = path.posix.dirname(file.slice('src/renderer/'.length))
    if (renderer) directories[directory] ||= emptyCounts()
    const white = budget.whitelist.some(entry => minimatch(file, entry.glob))
    const add = (metric, position) => {
      if (!renderer || (metric === 'color' && white)) return
      directories[directory][metric]++
      locations.push({ directory, metric, file, line: text.slice(0, position).split('\n').length })
    }
    let clean = text
    if (/\.[cm]?[jt]sx?$/.test(ext)) clean = scanScript(text, file, 0, add)
    else if (ext === '.css') clean = renderer ? scanCss(text, 0, add) : cssWithoutComments(text)
    else if (ext === '.html' || ext === '.svg') clean = scanHtml(text, add)
    if (budget.retiredAllowFiles.includes(file)) continue
    for (const key of RETIRED) {
      const pattern = new RegExp(`(?<![\\w$-])${key}(?![\\w$-])`, 'g')
      for (const match of clean.matchAll(pattern)) {
        retired[key]++
        locations.push({ directory: 'retired', metric: key, file, line: clean.slice(0, match.index).split('\n').length })
      }
    }
  }
  return { directories, retired, locations, totals: Object.fromEntries(METRICS.map(key => [key, Object.values(directories).reduce((sum, counts) => sum + counts[key], 0)])) }
}

function validateBudget(budget) {
  if (!budget.directories || !budget.retired || !Array.isArray(budget.whitelist) || !Array.isArray(budget.retiredAllowFiles)) throw new Error('预算格式不完整')
  for (const counts of [...Object.values(budget.directories), budget.retired]) {
    for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('预算必须为非负整数')
  }
  for (const entry of budget.whitelist) if (typeof entry.glob !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('每条白名单必须有 glob 和 reason')
}

function compare(current, budget) {
  const exceeded = [], lower = []
  function check(directory, metric, actual, ceiling) {
    const entry = { directory, metric, current: actual, budget: ceiling }
    if (actual > ceiling) exceeded.push(entry)
    if (actual < ceiling) lower.push(entry)
  }
  for (const directory of new Set([...Object.keys(current.directories), ...Object.keys(budget.directories)])) {
    for (const metric of METRICS) check(directory, metric, current.directories[directory]?.[metric] ?? 0, budget.directories[directory]?.[metric] ?? 0)
  }
  for (const key of RETIRED) check('retired', key, current.retired[key] ?? 0, budget.retired[key] ?? 0)
  return { exceeded, lower }
}

function main(argv) {
  let root = path.resolve(__dirname, '..'), budgetFile = 'scripts/design-budget.json', write = false, json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--write') write = true
    else if (arg === '--json') json = true
    else if ((arg === '--root' || arg === '--budget') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (arg === '--root') root = path.resolve(argv[++i])
      else budgetFile = argv[++i]
    } else throw new Error(`未知参数或缺少值：${arg}`)
  }
  budgetFile = path.resolve(root, budgetFile)
  const headResult = spawnSync('git', ['show', 'HEAD:scripts/design-budget.json'], { cwd: root, encoding: 'utf8' })
  const head = headResult.status === 0 ? JSON.parse(headResult.stdout) : null
  const exists = fs.existsSync(budgetFile)
  if (!exists && (!write || head)) throw new Error('预算文件缺失；只有 HEAD 尚无预算时可用 --write 首次建档')
  const budget = exists ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : initialBudget()
  validateBudget(budget)
  if (head) validateBudget(head)
  const raised = head ? compare(budget, head).exceeded : []
  const current = scan(root, budget)
  if (!exists) { budget.directories = current.directories; budget.retired = current.retired }
  const { exceeded, lower } = compare(current, budget)
  // A numeric baseline cannot identify old occurrences. Added HEAD diff lines are
  // preferred; without that evidence, report every current hit as a candidate.
  const diff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=0', 'HEAD', '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const added = new Set()
  let file = '', line = 0
  for (const row of (diff.stdout || '').split('\n')) {
    if (row.startsWith('+++ b/')) file = row.slice(6)
    else if (row.startsWith('@@')) line = Number(row.match(/\+(\d+)/)[1])
    else if (row.startsWith('+')) added.add(`${file}:${line++}`)
    else if (row.startsWith(' ')) line++
  }
  for (const entry of exceeded) {
    const hits = current.locations.filter(hit => hit.directory === entry.directory && hit.metric === entry.metric)
    const newHits = hits.filter(hit => added.has(`${hit.file}:${hit.line}`))
    entry.locations = newHits.length ? newHits : hits
    entry.locationBasis = newHits.length ? 'added-lines' : 'current-candidates'
  }
  if (write && raised.length === 0) {
    for (const entry of lower) {
      if (entry.directory === 'retired') budget.retired[entry.metric] = entry.current
      else budget.directories[entry.directory][entry.metric] = entry.current
    }
    fs.mkdirSync(path.dirname(budgetFile), { recursive: true })
    fs.writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`)
  }
  const ok = exceeded.length === 0 && raised.length === 0
  if (json) console.log(JSON.stringify({ ok, ...current, exceeded, raised, lower, written: write && raised.length === 0 }, null, 2))
  else {
    console.log(`[design-tokens] ${ok ? 'OK' : 'FAIL'} color=${current.totals.color} backdropFilter=${current.totals.backdropFilter} fontFace=${current.totals.fontFace}`)
    for (const entry of raised) console.error(`预算高于 HEAD：${entry.directory} / ${entry.metric} / ${entry.current} / ${entry.budget}`)
    for (const entry of exceeded) {
      const positions = [...new Set(entry.locations.map(hit => `${hit.file}:${hit.line}`))].join(', ')
      console.error(`${entry.directory} / ${entry.metric} / ${entry.current} / ${entry.budget} / ${entry.locationBasis === 'added-lines' ? '新增位置' : '当前命中位置（无新增行证据）'}：${positions}`)
    }
    if (lower.length) console.log(write ? '已下调预算；超额项保持原预算。' : '可以下调：运行 --write')
  }
  return ok ? 0 : 1
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) }
  catch (error) {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.message }))
    else console.error(error.message)
    process.exitCode = 1
  }
}
