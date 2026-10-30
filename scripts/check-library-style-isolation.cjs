#!/usr/bin/env node
// allow-source-grep: Structural CSS boundary contract; browser behavior cannot prove that every future selector is scoped.
const fs = require('node:fs')
const path = require('node:path')
const postcss = require('postcss')

function check(css, file) {
  const errors = []
  postcss.parse(css, { from: file }).walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return
    let parent = rule.parent
    while (parent && !(parent.type === 'atrule' && parent.name === 'layer' && parent.params === 'ready-next.library')) parent = parent.parent
    if (!parent) errors.push(`${file}: ${rule.selector}: missing @layer ready-next.library`)
    for (const selector of rule.selectors) {
      if (!/^\.rn-library(?=[\s.:#[>+~]|$)/.test(selector)) errors.push(`${file}: unscoped ${selector}`)
      if (/^\.rn-library\s*[+~]/.test(selector)) errors.push(`${file}: sibling escapes root: ${selector}`)
    }
  })
  return errors
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []) }
if (require.main === module) {
  const files = walk(path.resolve('src/renderer/modules/library'))
  const errors = files.flatMap(file => check(fs.readFileSync(file, 'utf8'), file))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log(`[library-style-isolation] OK — ${files.length} stylesheets scoped and layered`)
}
module.exports = { check }
