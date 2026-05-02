#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const SCAN_DIRS = [
  'src/main/modules/agent-control',
  'src/main/modules/skills-runtime',
]

const ALLOWED_FILE_PATTERNS = [
  /(^|\/)atomic-write\.ts$/,
  /(^|\/)__tests__\//,
  /\.test\.[cm]?tsx?$/,
]

function checkAtomicWrites({ root = process.cwd() } = {}) {
  const errors = []
  for (const dir of SCAN_DIRS) {
    const absDir = join(root, dir)
    if (!existsSync(absDir)) continue
    for (const file of walk(absDir)) {
      const rel = normalize(relative(root, file))
      if (ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(rel))) continue
      const source = readFileSync(file, 'utf8')
      for (const violation of findViolations(source)) {
        errors.push(`${rel}:${violation.line}: direct JSON-ish write should use atomicWriteJson (${violation.snippet})`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      yield* walk(path)
    } else if (/\.[cm]?tsx?$/.test(entry)) {
      yield path
    }
  }
}

function findViolations(source) {
  const violations = []
  for (const call of findWriteFileCalls(source)) {
    const args = call.args
    const firstArg = firstArgument(args)
    if (!isJsonishWrite(firstArg, args)) continue
    violations.push({
      line: lineNumberAt(source, call.index),
      snippet: compact(call.source),
    })
  }
  return violations
}

function findWriteFileCalls(source) {
  const calls = []
  const calleePattern = /(?:\bfs\.)?\b(writeFileSync|writeFile)\s*\(/g
  for (const match of source.matchAll(calleePattern)) {
    const openIndex = (match.index || 0) + match[0].length - 1
    const closeIndex = findMatchingParen(source, openIndex)
    if (closeIndex === -1) continue
    calls.push({
      index: match.index || 0,
      args: source.slice(openIndex + 1, closeIndex),
      source: source.slice(match.index || 0, closeIndex + 1),
    })
  }
  return calls
}

function findMatchingParen(source, openIndex) {
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function firstArgument(args) {
  let quote = null
  let depth = 0
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === ',' && depth === 0) return args.slice(0, index)
  }
  return args
}

function isJsonishWrite(firstArg, args) {
  if (/\.json['"`]/.test(firstArg)) return true
  if (/\bJSON\.stringify\s*\(/.test(args)) return true
  return false
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function compact(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function normalize(path) {
  return path.split('\\').join('/')
}

if (require.main === module) {
  const result = checkAtomicWrites()
  if (!result.ok) {
    console.error(result.errors.join('\n'))
    process.exit(1)
  }
}

module.exports = {
  checkAtomicWrites,
  findViolations,
}
