#!/usr/bin/env node
/**
 * Stage U0.1 — CI gate: forbid consuming `ipcMain.emit(...)` as if it
 * returned the handler result.
 *
 * Why this gate exists
 * --------------------
 * `ipcMain.emit` is `EventEmitter.prototype.emit`. It returns a `boolean`
 * (whether any listener fired), NOT the handler's return value. The deleted
 * `claude-bridge/ipc-handler.ts` legacy `tool_execute` branch did:
 *
 *   result = await ipcMain.emit('calendar:createEvent', data.args)
 *          || { success: true, message: 'Event creation forwarded' }
 *
 * which always reported success regardless of whether the calendar event
 * was actually created. That is a live product bug. This gate prevents it
 * from coming back, including through helper wrappers.
 *
 * Coverage (TypeScript Compiler API)
 * ----------------------------------
 *   1. Direct consumption: any `ipcMain.emit(...)` expression whose value
 *      is consumed as:
 *        - the right-hand side of an assignment / variable initializer
 *        - an operand of `||` / `&&` / `??`
 *        - the condition of a ternary / `if` / `while` / `for`
 *        - a `return` value
 *        - awaited (`await ipcMain.emit(...)`) and then consumed
 *
 *   2. Taint tracking: if the result is assigned to a local variable `x`,
 *      any read of `x` within the next 5 source lines that is consumed by
 *      one of the above forms is also a violation.
 *
 *   3. Helper detection: a function declaration whose body returns
 *      `ipcMain.emit(...)` (optionally combined with `||` / `&&` / `??` /
 *      ternary) is treated as a wrapper. The function name is added to the
 *      taint set; subsequent consumers of `wrapper(...)` are flagged just
 *      like direct calls.
 *
 * Allowed (no violation)
 * ----------------------
 *   - Statement-level fire-and-forget: `ipcMain.emit('foo', payload)` on
 *     its own line as an `ExpressionStatement` — the return value is
 *     discarded. (Note: while we tolerate this for forward-compat with
 *     diagnostic uses, repo policy already forbids cross-boundary
 *     fire-and-forget at a higher level; this gate only targets the
 *     "fake handler return" bug class.)
 *   - The gate itself and its tests.
 *
 * Exits
 * -----
 *   0 — clean
 *   1 — at least one violation (prints file:line:col + diagnostic)
 */

'use strict'

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const ts = require('typescript')

const DEFAULT_ROOT = resolve(__dirname, '..')
const DEFAULT_SCAN_DIRS = ['src']
const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', '.git', 'coverage'])
const SKIP_FILE_SUFFIXES = ['.d.ts']
// Files we should not scan: this gate, its tests, and snapshot/example data.
const SKIP_PATH_FRAGMENTS = [
  'scripts/check-no-ipcmain-emit-truthy.cjs',
  'scripts/__tests__/check-no-ipcmain-emit-truthy.test.cjs',
]

const TAINT_LINE_WINDOW = 5

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkNoIpcMainEmitTruthy(options)
    if (result.violations.length > 0) {
      console.error('[Stage U0.1: check-no-ipcmain-emit-truthy] FAIL')
      for (const v of result.violations) {
        console.error(`  ${v.file}:${v.line}:${v.column} ${v.message}`)
      }
      console.error(
        '\nipcMain.emit returns a boolean (listener-fired flag), not the handler result.\n'
        + 'Consuming it as a value is the calendar fake-success bug class. Route through\n'
        + 'a real ipcMain.handle/ipcRenderer.invoke pair or call the handler function directly.',
      )
      process.exit(1)
    }
    console.log('[Stage U0.1: check-no-ipcmain-emit-truthy] OK')
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    scanDirs: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --root')
      options.root = resolve(value)
      i += 1
    } else if (arg === '--scan-dir') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --scan-dir')
      if (!options.scanDirs) options.scanDirs = []
      options.scanDirs.push(value)
      i += 1
    } else {
      throw new Error(`Unknown argument "${arg}"`)
    }
  }
  return options
}

function checkNoIpcMainEmitTruthy({ root = DEFAULT_ROOT, scanDirs = null } = {}) {
  const rootDir = resolve(root)
  const dirs = scanDirs && scanDirs.length > 0 ? scanDirs : DEFAULT_SCAN_DIRS
  const files = []
  for (const dir of dirs) {
    const abs = resolve(rootDir, dir)
    if (!existsSync(abs)) continue
    collectTsFiles(abs, files)
  }

  const violations = []
  for (const file of files) {
    const relPath = normalize(relative(rootDir, file))
    if (shouldSkipPath(relPath)) continue
    const sourceText = readFileSync(file, 'utf8')
    if (!sourceText.includes('ipcMain')) continue
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    scanFile({ sourceFile, relPath, violations })
  }

  return { violations }
}

function collectTsFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectTsFiles(full, out)
    } else if (entry.isFile() && isTypescriptSource(entry.name)) {
      out.push(full)
    }
  }
}

function isTypescriptSource(name) {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false
  for (const suffix of SKIP_FILE_SUFFIXES) if (name.endsWith(suffix)) return false
  return true
}

function shouldSkipPath(relPath) {
  for (const frag of SKIP_PATH_FRAGMENTS) if (relPath.includes(frag)) return true
  return false
}

function normalize(p) {
  return p.replaceAll('\\', '/')
}

/**
 * Scan a single source file.
 *
 * Strategy:
 *   1. First pass: collect every CallExpression that is `ipcMain.emit(...)`
 *      and check the enclosing expression chain for consumption.
 *   2. Identify helper functions whose body returns `ipcMain.emit(...)` (or
 *      a logical/ternary combination involving it). Add their names to a
 *      "tainted callable" set.
 *   3. Identify variable declarations initialized by `ipcMain.emit(...)`
 *      OR by a tainted-callable call. Record each binding's line range
 *      (declaration line .. declaration line + TAINT_LINE_WINDOW).
 *   4. Second pass: every Identifier read inside a binding's window is
 *      checked the same way the original CallExpression is.
 *   5. Also flag every CallExpression of a tainted callable.
 */
function scanFile({ sourceFile, relPath, violations }) {
  const taintedCallables = new Set()
  const taintedBindings = new Map() // name -> { declLine, windowEndLine }

  // First, find helper definitions: function X(...) { return ipcMain.emit(...) [|| ...] }
  collectTaintedCallables(sourceFile, taintedCallables)

  // Second, walk the AST: report direct ipcMain.emit consumption, record
  // tainted variable bindings, and walk again to check binding reads.
  function visit(node) {
    if (isIpcMainEmitCall(node)) {
      const consumer = describeConsumption(node)
      if (consumer) {
        report(sourceFile, node, violations, relPath, `ipcMain.emit(...) result is consumed as ${consumer}`)
      }
    }

    if (isTaintedCallableCall(node, taintedCallables)) {
      const consumer = describeConsumption(node)
      if (consumer) {
        const name = node.expression.text
        report(
          sourceFile,
          node,
          violations,
          relPath,
          `result of helper "${name}" (wraps ipcMain.emit) is consumed as ${consumer}`,
        )
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = stripAwait(node.initializer)
      const tainted
        = isIpcMainEmitCall(initializer)
        || isTaintedCallableCall(initializer, taintedCallables)
      if (tainted && ts.isIdentifier(node.name)) {
        const declLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        // Always report the assignment itself as a consumption (initializer captures the boolean).
        report(
          sourceFile,
          node,
          violations,
          relPath,
          'ipcMain.emit(...) result is captured into a variable; the value is a boolean and must not be reused',
        )
        taintedBindings.set(node.name.text, {
          declLine,
          windowEndLine: declLine + TAINT_LINE_WINDOW,
        })
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const rhs = stripAwait(node.right)
      const tainted
        = isIpcMainEmitCall(rhs)
        || isTaintedCallableCall(rhs, taintedCallables)
      if (tainted && ts.isIdentifier(node.left)) {
        const declLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        report(
          sourceFile,
          node,
          violations,
          relPath,
          'ipcMain.emit(...) result is assigned to a variable; the value is a boolean and must not be reused',
        )
        taintedBindings.set(node.left.text, {
          declLine,
          windowEndLine: declLine + TAINT_LINE_WINDOW,
        })
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (taintedBindings.size === 0) return

  // Walk again to catch reads of tainted bindings inside the line window.
  function visitReads(node) {
    if (ts.isIdentifier(node) && taintedBindings.has(node.text) && isValueRead(node)) {
      const binding = taintedBindings.get(node.text)
      const useLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      if (useLine > binding.declLine && useLine <= binding.windowEndLine) {
        const consumer = describeIdentifierConsumption(node)
        if (consumer) {
          report(
            sourceFile,
            node,
            violations,
            relPath,
            `tainted "${node.text}" (holds ipcMain.emit boolean) is consumed as ${consumer} within `
              + `${TAINT_LINE_WINDOW} lines of its assignment`,
          )
        }
      }
    }
    ts.forEachChild(node, visitReads)
  }
  visitReads(sourceFile)
}

function isIpcMainEmitCall(node) {
  if (!node || !ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  if (!ts.isIdentifier(callee.name) || callee.name.text !== 'emit') return false
  if (!ts.isIdentifier(callee.expression)) return false
  return callee.expression.text === 'ipcMain'
}

function isTaintedCallableCall(node, taintedCallables) {
  if (!node || !ts.isCallExpression(node)) return false
  if (!ts.isIdentifier(node.expression)) return false
  return taintedCallables.has(node.expression.text)
}

function stripAwait(node) {
  if (!node) return node
  if (ts.isAwaitExpression(node)) return stripAwait(node.expression)
  if (ts.isParenthesizedExpression(node)) return stripAwait(node.expression)
  return node
}

function unwrapForConsumption(node) {
  // Walk outward through await / parens / non-null-assertion / `as` casts so
  // we can detect consumption that happens after a coercion.
  let current = node
  while (current && current.parent) {
    const parent = current.parent
    if (
      ts.isAwaitExpression(parent)
      || ts.isParenthesizedExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression?.(parent)
      || ts.isSatisfiesExpression?.(parent)
    ) {
      current = parent
      continue
    }
    break
  }
  return current
}

/**
 * Describe the consumption shape of `node` (which is itself an expression
 * we've already classified as tainted). Returns a human-readable string or
 * `null` if the result is genuinely discarded.
 */
function describeConsumption(node) {
  const effective = unwrapForConsumption(node)
  const parent = effective.parent
  if (!parent) return null

  if (ts.isVariableDeclaration(parent) && parent.initializer === effective) {
    return 'a variable initializer'
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind
    if (op === ts.SyntaxKind.EqualsToken && parent.right === effective) {
      return 'an assignment'
    }
    if (
      op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.AmpersandAmpersandToken
      || op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return `a logical "${tokenText(op)}" operand`
    }
  }
  if (ts.isConditionalExpression(parent) && parent.condition === effective) {
    return 'a ternary condition'
  }
  if (ts.isConditionalExpression(parent) && (parent.whenTrue === effective || parent.whenFalse === effective)) {
    return 'a ternary branch'
  }
  if (ts.isIfStatement(parent) && parent.expression === effective) {
    return 'an if-condition'
  }
  if (
    (ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isForStatement(parent))
    && parent.expression === effective
  ) {
    return 'a loop condition'
  }
  if (ts.isReturnStatement(parent) && parent.expression === effective) {
    return 'a return value'
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === effective) {
    return 'a property access target'
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === effective) {
    return 'an indexed-access target'
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(effective)) {
    return 'a call argument'
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return 'a negation operand'
  }
  // Standalone expression statement — value discarded.
  return null
}

function describeIdentifierConsumption(idNode) {
  // For identifier reads, the same parent inspection works.
  return describeConsumption(idNode)
}

function tokenText(kind) {
  if (kind === ts.SyntaxKind.BarBarToken) return '||'
  if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return '&&'
  if (kind === ts.SyntaxKind.QuestionQuestionToken) return '??'
  return ts.tokenToString(kind) || String(kind)
}

function isValueRead(idNode) {
  const parent = idNode.parent
  if (!parent) return false
  // Skip declaration sites and write positions.
  if (ts.isVariableDeclaration(parent) && parent.name === idNode) return false
  if (ts.isBindingElement(parent) && parent.name === idNode) return false
  if (ts.isParameter(parent) && parent.name === idNode) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === idNode) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === idNode) return false
  if (ts.isPropertyAssignment(parent) && parent.name === idNode) return false
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === idNode) {
    return false
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false
  return true
}

/**
 * Collect names of functions whose body returns an expression involving
 * `ipcMain.emit(...)`. We recognise:
 *
 *   function helper(...) { return ipcMain.emit(...) }
 *   function helper(...) { return ipcMain.emit(...) || fallback }
 *   const helper = (...) => ipcMain.emit(...) || fallback
 *   const helper = function (...) { return await ipcMain.emit(...) ?? x }
 */
function collectTaintedCallables(sourceFile, taintedCallables) {
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (bodyTaintsByEmit(node.body)) taintedCallables.add(node.name.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
        if (bodyTaintsByEmit(init.body)) taintedCallables.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function bodyTaintsByEmit(body) {
  if (!body) return false
  // Arrow function expression body.
  if (!ts.isBlock(body)) {
    return expressionContainsEmit(body)
  }
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression && expressionContainsEmit(stmt.expression)) {
      return true
    }
  }
  return false
}

function expressionContainsEmit(expr) {
  const e = stripAwait(expr)
  if (isIpcMainEmitCall(e)) return true
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (
      op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.AmpersandAmpersandToken
      || op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return expressionContainsEmit(e.left) || expressionContainsEmit(e.right)
    }
  }
  if (ts.isConditionalExpression(e)) {
    return (
      expressionContainsEmit(e.condition)
      || expressionContainsEmit(e.whenTrue)
      || expressionContainsEmit(e.whenFalse)
    )
  }
  return false
}

function report(sourceFile, node, violations, relPath, message) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  violations.push({
    file: relPath,
    line: pos.line + 1,
    column: pos.character + 1,
    message,
  })
}

// Quiet unused-symbol warnings for utility helpers exported for tests.
void statSync

module.exports = {
  checkNoIpcMainEmitTruthy,
}
