const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function check(root) {
  const errors = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { visit(file); continue }
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(test|spec)\./.test(file)) continue
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function walk(node) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
          && /application\/x-ready-(?!ref(?:$|[^\w-]))[\w-]+/.test(node.text)) errors.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`)
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
  }
  visit(root)
  return errors
}
module.exports = { check }
if (require.main === module) {
  const errors = check(path.resolve(__dirname, '../src'))
  if (errors.length) { console.error('Retired internal drag formats:', errors.join('\n')); process.exitCode = 1 }
  else console.log('Drag formats: only application/x-ready-ref')
}
