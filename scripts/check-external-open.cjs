#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Exact call sites and counts, not whole-file exemptions. New calls require a reason here.
const allow = [
  ['src/renderer/modules/browser/useBrowserTabActions.ts', "window.open(activeTab.url, '_blank')", 1, '用户明确选择在系统浏览器打开'],
  ['src/main/index.ts', 'shell.openExternal(details.url)', 1, '承接渲染层显式外开菜单的 window.open'],
  ['src/main/modules/settings-engine/chatgpt-oauth-service.ts', 'shell.openExternal(url)', 1, 'ChatGPT OAuth 在系统浏览器认证'],
  ['src/main/modules/browser-engine/browser-controller-composition.ts', 'shell.openExternal(url)', 2, '显式外开菜单及 popup policy 判定的外部协议'],
  ['src/main/modules/browser-engine/context-menu-service.ts', 'shell.openExternal(linkUrl)', 1, '用户明确选择在外部浏览器打开链接'],
  ['src/main/modules/browser-engine/context-menu-service.ts', 'shell.openExternal(imageUrl)', 1, '用户明确选择在外部浏览器打开图片'],
  ['src/main/modules/browser-engine/context-menu-service.ts', 'shell.openExternal(`view-source:${url}`)', 1, '查看源码的外部协议'],
  ['src/main/modules/browser-engine/auth-popup-manager.ts', 'shell.openExternal(details.url)', 1, '认证弹窗策略的外部协议'],
  ['src/main/modules/browser-engine/auth-popup-manager.ts', 'shell.openExternal(url)', 2, '认证回跳到外部应用协议'],
]
const normalize = value => value.replace(/\s+/g, '')
function check(root) {
  const counts = new Map(), errors = []
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { scan(file); continue }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue
      const relative = path.relative(root, file).split(path.sep).join('/')
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const callee = normalize(node.expression.getText(source))
          const forbidden = relative.startsWith('src/renderer/') ? callee === 'window.open' : callee === 'shell.openExternal'
          if (forbidden) {
            const index = allow.findIndex(([name, call]) => name === relative && normalize(call) === normalize(node.getText(source)))
            if (index < 0) errors.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: 未列入外开白名单`)
            else counts.set(index, (counts.get(index) || 0) + 1)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  for (const area of ['renderer', 'main']) scan(path.join(root, 'src', area))
  for (const [index, count] of counts) if (count > allow[index][2]) errors.push(`${allow[index][0]}: 外开调用超过白名单数量`)
  return errors
}
if (require.main === module) {
  const errors = check(process.argv[2] || path.resolve(__dirname, '..'))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('External-open check passed')
}
module.exports = { check }
