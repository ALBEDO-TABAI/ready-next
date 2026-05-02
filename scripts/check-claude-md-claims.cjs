#!/usr/bin/env node

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

const DOCS = ['CLAUDE.md', 'AGENTS.md']
const SEARCH_ROOTS = [
  'src/main/modules',
  'src/main/utils',
  'src/shared',
  'src/preload',
  'scripts',
  'eslint-rules',
]
const SEARCH_FILES = ['package.json']
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
])
const IGNORED_TOKENS = new Set([
  'AbortError',
  'Electron',
  'JSON',
  'Node',
  'POSIX',
  'Promise',
  'SQLite',
  'TypeScript',
  'Windows',
  'Zod',
  'awk',
  'bash',
  'cat',
  'cd',
  'curl',
  'echo',
  'false',
  'ffmpeg',
  'ffprobe',
  'find',
  'grep',
  'head',
  'isXxxEnabled',
  'node',
  'null',
  'pwd',
  'python',
  'python3',
  'rm',
  'scenedetect',
  'sed',
  'sh',
  'string',
  'true',
  'undefined',
  'which',
  'yt-dlp',
])

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkClaudeMdClaims(options)
    if (!result.ok) {
      for (const error of result.errors) console.error(error)
      process.exit(1)
    }
    console.log('CLAUDE.md claims: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = { root: resolve(__dirname, '..') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --root.')
      options.root = resolve(value)
      i += 1
    } else {
      throw new Error(`Unknown argument "${arg}".`)
    }
  }
  return options
}

function checkClaudeMdClaims({ root = resolve(__dirname, '..') } = {}) {
  const rootDir = resolve(root)
  const corpus = buildCorpus(rootDir)
  const errors = []

  for (const doc of DOCS) {
    const docPath = join(rootDir, doc)
    if (!existsSync(docPath)) {
      errors.push(`${doc}: missing`)
      continue
    }
    const text = readFileSync(docPath, 'utf8')
    const section = extractSection(text)
    for (const claim of extractClaims(section.text, section.startLine)) {
      for (const error of validateClaim({ rootDir, corpus, doc, claim })) {
        errors.push(error)
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}

function extractSection(text) {
  const lines = text.split(/\r?\n/)
  const startIndex = lines.findIndex((line) => /^###\s+6\.12\b/.test(line))
  if (startIndex === -1) return { text: '', startLine: 1 }
  const endOffset = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^##\s+7\b/.test(line))
  const endIndex = endOffset === -1 ? lines.length : startIndex + 1 + endOffset
  return {
    text: lines.slice(startIndex, endIndex).join('\n'),
    startLine: startIndex + 1,
  }
}

function extractClaims(sectionText, startLine) {
  const claims = []
  const lines = sectionText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const regex = /`([^`]+)`/g
    let match
    while ((match = regex.exec(line)) !== null) {
      claims.push({
        text: match[1].trim(),
        line: startLine + i,
      })
    }
  }
  return claims
}

function validateClaim({ rootDir, corpus, doc, claim }) {
  const errors = []
  const pathResult = validatePathClaim({ rootDir, doc, claim })
  if (pathResult.handled) {
    if (pathResult.error) errors.push(pathResult.error)
    return errors
  }

  for (const token of extractTokens(claim.text)) {
    if (!shouldCheckToken(token)) continue
    if (!corpus.includes(token)) {
      errors.push(`${doc}:${claim.line}: undefined identifier '${token}' — does not exist in code`)
    }
  }
  return errors
}

function validatePathClaim({ rootDir, doc, claim }) {
  if (claim.text.includes('<') || claim.text.includes('>')) return { handled: false }
  if (!/^(src|scripts|docs|eslint-rules)\//.test(claim.text)) return { handled: false }

  const [file, symbol] = claim.text.split('::')
  const absoluteFile = join(rootDir, file)
  if (!existsSync(absoluteFile)) {
    return {
      handled: true,
      error: `${doc}:${claim.line}: undefined path '${file}' — does not exist`,
    }
  }
  if (symbol) {
    const source = readFileSync(absoluteFile, 'utf8')
    if (!source.includes(symbol)) {
      return {
        handled: true,
        error: `${doc}:${claim.line}: undefined identifier '${symbol}' — does not exist in ${file}`,
      }
    }
  }
  return { handled: true }
}

function extractTokens(text) {
  const withoutPlaceholders = text.replace(/<[^>]+>/g, ' ')
  const tokens = withoutPlaceholders.match(/[A-Za-z_$][A-Za-z0-9_$:-]*/g)
  return tokens || []
}

function shouldCheckToken(token) {
  if (IGNORED_TOKENS.has(token)) return false
  if (token.length < 4) return false
  if (/^\d/.test(token)) return false
  if (/^[a-z]+$/.test(token)) return false
  if (token.includes('-') && !token.includes(':')) return false
  if (token.startsWith('http')) return false
  return (
    token.includes('_')
    || token.includes(':')
    || /^[A-Z0-9_]+$/.test(token)
    || /[a-z][A-Z]/.test(token)
    || /^[A-Z][A-Za-z0-9_$]+$/.test(token)
  )
}

function buildCorpus(rootDir) {
  const chunks = []
  for (const root of SEARCH_ROOTS) {
    const absoluteRoot = join(rootDir, root)
    if (existsSync(absoluteRoot)) chunks.push(...readSourceFiles(absoluteRoot, rootDir))
  }
  for (const file of SEARCH_FILES) {
    const absoluteFile = join(rootDir, file)
    if (existsSync(absoluteFile)) chunks.push(readFileSync(absoluteFile, 'utf8'))
  }
  return chunks.join('\n')
}

function readSourceFiles(dir, rootDir) {
  const chunks = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      chunks.push(...readSourceFiles(path, rootDir))
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.has(extensionOf(entry.name))) continue
    chunks.push(`\n// ${relative(rootDir, path)}\n`)
    chunks.push(readFileSync(path, 'utf8'))
  }
  return chunks
}

function extensionOf(file) {
  const index = file.lastIndexOf('.')
  return index === -1 ? '' : file.slice(index)
}

module.exports = {
  checkClaudeMdClaims,
  extractClaims,
  extractSection,
  shouldCheckToken,
}
