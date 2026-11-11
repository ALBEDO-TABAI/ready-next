const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function normalize(keys) {
  const aliases = { Cmd: 'Command', Meta: 'Command', Ctrl: 'Control', Option: 'Alt', CmdOrCtrl: 'CommandOrControl' }
  const parts = keys.split('+').map(key => aliases[key] || key)
  const key = parts.pop().toLowerCase()
  const variants = parts.includes('CommandOrControl') ? ['Command', 'Control'] : [null]
  return variants.map(mod => [...parts.filter(p => p !== 'CommandOrControl'), ...(mod ? [mod] : [])].sort().join('+') + ':' + key)
}
function checkTable(shortcuts) {
  const seen = new Set(), ids = new Set(), errors = []
  for (const shortcut of shortcuts) {
    if (ids.has(shortcut.id)) errors.push(`Duplicate shortcut id: ${shortcut.id}`)
    ids.add(shortcut.id)
    for (const chord of normalize(shortcut.keys)) {
      const key = `${shortcut.scope}:${chord}`
      if (seen.has(key)) errors.push(`Duplicate shortcut in ${shortcut.scope}: ${shortcut.keys}`)
      seen.add(key)
    }
  }
  return errors
}

// Small, conservative expression reader: keyboard fields, aliases and Boolean guards only.
// Unknown application state stays unknown; no application code is executed by the scanner.
function inspectSource(filename, source, shortcuts) {
  if (!/\b(metaKey|ctrlKey|globalShortcut|accelerator)\b/.test(source)) return []
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const moduleScope = filename.replaceAll('\\', '/').match(/\/(?:modules|components)\/(calendar|canvas|document)\//)?.[1]
    || (filename.endsWith('/SkillsCenterPanel.tsx') ? 'skills' : 'global')
  const scope = source.match(/\/\/ shortcut-scope: (\w+) -- (\S[^\n]*)/)?.[1] || moduleScope
  const allowed = new Set(shortcuts.filter(s => s.scope === 'global' || s.scope === scope).flatMap(s => normalize(s.keys)))
  const errors = new Set()
  const bindings = node => {
    const aliases = new Map()
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) for (const statement of parent.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer && !aliases.has(declaration.name.text)) aliases.set(declaration.name.text, declaration.initializer)
        }
      }
    }
    return aliases
  }
  function value(node, event, aliases, seen = new Set()) {
    if (!node) return undefined
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return value(node.expression, event, aliases, seen)
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isIdentifier(node)) {
      if (node.text in event) return event[node.text]
      if (node.text === 'isMac') return event.metaKey
      if (!seen.has(node.text) && aliases.has(node.text)) return value(aliases.get(node.text), event, aliases, new Set([...seen, node.text]))
    }
    if (ts.isPropertyAccessExpression(node)) return event[node.name.text]
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = value(node.expression.expression, event, aliases, seen)
      if (node.expression.name.text === 'toLowerCase' && typeof receiver === 'string') return receiver.toLowerCase()
      if (node.expression.name.text === 'includes' && ts.isArrayLiteralExpression(node.expression.expression)) {
        const needle = value(node.arguments[0], event, aliases, seen)
        if (needle !== undefined) return node.expression.expression.elements.some(item => value(item, event, aliases, seen) === needle)
      }
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const result = value(node.operand, event, aliases, seen); return result === undefined ? undefined : !result
    }
    if (ts.isConditionalExpression(node)) {
      const condition = value(node.condition, event, aliases, seen)
      return condition === undefined ? undefined : value(condition ? node.whenTrue : node.whenFalse, event, aliases, seen)
    }
    if (ts.isBinaryExpression(node)) {
      const left = value(node.left, event, aliases, seen), right = value(node.right, event, aliases, seen)
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken: return left === false || right === false ? false : left === undefined || right === undefined ? undefined : Boolean(left && right)
        case ts.SyntaxKind.BarBarToken: return left === true || right === true ? true : left === undefined || right === undefined ? undefined : Boolean(left || right)
        case ts.SyntaxKind.EqualsEqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsToken: return left === undefined || right === undefined ? undefined : left === right
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: case ts.SyntaxKind.ExclamationEqualsToken: return left === undefined || right === undefined ? undefined : left !== right
      }
    }
    return undefined
  }
  function expanded(node, aliases, seen = new Set()) {
    if (ts.isIdentifier(node) && aliases.has(node.text) && !seen.has(node.text)) return expanded(aliases.get(node.text), aliases, new Set([...seen, node.text]))
    const children = []
    ts.forEachChild(node, child => { children.push(expanded(child, aliases, seen)) })
    return [ts.isIdentifier(node) ? node.text : '', ...children].join(' ')
  }
  function report(keys, node) {
    if (!normalize(keys).every(chord => allowed.has(chord))) errors.add(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: unregistered shortcut ${keys} (${scope})`)
  }
  function inspectCondition(node, condition) {
    const aliases = bindings(node), conditions = [condition]
    for (let parent = node.parent, child = node; parent; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent)) conditions.push(parent.thenStatement === child ? parent.expression : ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, parent.expression))
      // A preceding unconditional return guard constrains the rest of that block.
      if (ts.isBlock(parent)) for (const statement of parent.statements) {
        if (statement.pos >= child.pos) break
        if (ts.isIfStatement(statement) && !statement.elseStatement && (ts.isReturnStatement(statement.thenStatement) || (ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1 && ts.isReturnStatement(statement.thenStatement.statements[0])))) {
          conditions.push(ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, statement.expression))
        }
      }
      if (ts.isFunctionLike(parent)) break
    }
    const text = conditions.map(c => expanded(c, aliases)).join(' ')
    if (!/\b(metaKey|ctrlKey)\b/.test(text)) return
    const keys = new Set()
    function collect(n) {
      if (ts.isStringLiteral(n)) keys.add(n.text)
      ts.forEachChild(n, collect)
    }
    collect(condition)
    for (const key of keys) {
      if (!key || (key.length > 1 && !/^(Enter|Tab|Backspace|Delete|Arrow\w+|Key[A-Z]|Backslash|Escape|[Ff]\d+)$/.test(key))) continue
      const candidates = []
      for (let bits = 0; bits < 16; bits++) {
        const event = { key, code: key, metaKey: !!(bits & 1), ctrlKey: !!(bits & 2), shiftKey: !!(bits & 4), altKey: !!(bits & 8) }
        if (conditions.some(c => value(c, event, aliases) === false)) continue
        candidates.push(event)
      }
      // An unmodified candidate means this branch is not a command/control shortcut.
      if (candidates.some(e => !e.metaKey && !e.ctrlKey)) continue
      for (const event of candidates) {
        if (candidates.some(other => other !== event && ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'].every(k => !other[k] || event[k]))) continue
        const base = { '>': '.', '<': ',', ')': '0', Backslash: '\\' }[key] || (/^Key[A-Z]$/.test(key) ? key.slice(3) : key)
        report([event.metaKey && 'Command', event.ctrlKey && 'Control', event.shiftKey && 'Shift', event.altKey && 'Alt', base].filter(Boolean).join('+'), node)
      }
    }
  }
  function walk(node) {
    // Narrow opt-out for a module-local handler; reason is mandatory, not a file blanket.
    const leading = source.slice(node.getFullStart(), node.getStart(file))
    if (ts.isFunctionLike(node) && /shortcut-internal: \S[^\n]*/.test(leading)) return
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) inspectCondition(node, ts.isIfStatement(node) ? node.expression : node.condition)
    if (ts.isCaseClause(node)) {
      const statement = node.parent.parent
      if (ts.isSwitchStatement(statement)) inspectCondition(node, ts.factory.createBinaryExpression(statement.expression, ts.SyntaxKind.EqualsEqualsEqualsToken, node.expression))
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'accelerator' && ts.isStringLiteral(node.initializer)) report(node.initializer.text, node)
    if (ts.isCallExpression(node) && /globalShortcut\.register$/.test(node.expression.getText(file)) && node.arguments[0]) {
      const key = value(node.arguments[0], {}, bindings(node))
      if (typeof key === 'string') report(key, node)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return [...errors]
}

function checkProject(root) {
  // The shared catalog has no imports or side effects; load the TypeScript with the project's compiler.
  const filename = path.join(root, 'src/shared/app-shortcuts.ts'), exports = {}
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', js)(exports)
  const shortcuts = exports.APP_SHORTCUTS, errors = checkTable(shortcuts)
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== '__tests__') scan(full)
      else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name) && !/\.(test|spec|d)\./.test(entry.name)) errors.push(...inspectSource(path.relative(root, full), fs.readFileSync(full, 'utf8'), shortcuts))
    }
  }
  scan(path.join(root, 'src/renderer')); scan(path.join(root, 'src/main'))
  return errors
}
module.exports = { normalize, checkTable, inspectSource, checkProject }
if (require.main === module) {
  const errors = checkProject(path.resolve(__dirname, '..'))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Shortcut catalog and source checks passed')
}
