#!/usr/bin/env node
// Gate: renderer CSS 禁止未分层的通用选择器 margin/padding reset。
//
// 背景（2026-07-10 根修）：Tailwind v4 把全部工具类生成在 @layer utilities 内；
// 按 CSS 级联层规则，未分层作者样式无条件压过所有分层样式。一条未分层的
// `* { margin:0; padding:0 }`（原 base-chrome.css）曾让全应用的 Tailwind
// margin/padding 工具类静默失效。全局 reset 语义由 Tailwind preflight
// （@layer base）承担；任何人再引入未分层通用 reset 必须被此 gate 拦下。
//
// 规则：src/renderer 下所有 .css 文件中，凡不在 @layer 块内的规则，
// 若选择器含裸通用选择器（*、*::before 等），其声明块不得出现 margin/padding。
// 用法：node scripts/check-css-cascade-layer-reset.cjs [scanDir]

const fs = require('node:fs')
const path = require('node:path')

const scanDir = process.argv[2] || path.join(__dirname, '..', 'src', 'renderer')

function listCssFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listCssFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

function stripComments(css) {
  // 保留换行以维持行号
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function isUniversalSelector(selectorList) {
  return selectorList.split(',').some((part) => {
    const s = part.trim()
    return s === '*' || /^\*::?[a-z-]+(\(\))?$/i.test(s)
  })
}

function findViolations(cssRaw, file) {
  const css = stripComments(cssRaw)
  const violations = []
  // 帧栈：每进入一个 {} 块压入该块是否处于 @layer 语境
  const layerStack = []
  let i = 0
  let tokenStart = 0 // 当前 selector/at-rule 文本的起点
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      const header = css.slice(tokenStart, i).trim()
      const inLayer = layerStack.some(Boolean) || /^@layer\b/.test(header)
      if (!inLayer && header && !header.startsWith('@') && isUniversalSelector(header)) {
        // 读取声明块内容（到配对的 }）
        let depth = 1
        let j = i + 1
        while (j < css.length && depth > 0) {
          if (css[j] === '{') depth++
          else if (css[j] === '}') depth--
          j++
        }
        const body = css.slice(i + 1, j - 1)
        if (/(^|[;{\s])(margin|padding)(-(top|right|bottom|left|block|inline|inline-start|inline-end|block-start|block-end))?\s*:/i.test(body)) {
          const line = css.slice(0, tokenStart).split('\n').length
          violations.push({ file, line, selector: header.replace(/\s+/g, ' ').slice(0, 80) })
        }
      }
      layerStack.push(/^@layer\b/.test(header) || layerStack.some(Boolean))
      tokenStart = i + 1
    } else if (ch === '}') {
      layerStack.pop()
      tokenStart = i + 1
    } else if (ch === ';' && layerStack.length === 0) {
      tokenStart = i + 1
    }
    i++
  }
  return violations
}

const files = listCssFiles(scanDir)
const all = []
for (const file of files) {
  all.push(...findViolations(fs.readFileSync(file, 'utf8'), file))
}

if (all.length > 0) {
  console.error('[css-layer-reset] FAIL — 未分层通用选择器 reset 会级联层压死 Tailwind 间距类：')
  for (const v of all) {
    console.error(`  ✗ ${path.relative(process.cwd(), v.file)}:${v.line}  selector "${v.selector}" 声明了 margin/padding（请放入 @layer base 或交给 Tailwind preflight）`)
  }
  process.exit(1)
}
console.log(`[css-layer-reset] OK — 扫描 ${files.length} 个 css 文件，无未分层通用 margin/padding reset`)
