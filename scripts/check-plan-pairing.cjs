#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const PLAN_DIR = 'docs/superpowers/plans'

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const result = checkPlanPairing(options)
  if (!result.ok) {
    console.error(result.errors.join('\n'))
    return 1
  }
  console.log(result.message)
  return 0
}

function checkPlanPairing(options = {}) {
  const root = resolve(options.root || process.cwd())
  const planDir = join(root, PLAN_DIR)
  if (!existsSync(planDir)) {
    return { ok: true, message: 'Plan pairing ok (no plan directory).', errors: [] }
  }

  const changedFiles = options.changedFiles?.length
    ? options.changedFiles.map(normalizePath)
    : options.all
      ? ['src/__all__']
      : collectChangedFiles(root, options.baseRef)
  const hasSourceChange = changedFiles.some(isSourceChange)
  if (!hasSourceChange) {
    return { ok: true, message: 'Plan pairing ok (no source changes).', errors: [] }
  }

  const files = readdirSync(planDir)
    .filter((name) => name.endsWith('.md'))
  const implementationSubjects = new Set(
    files
      .filter(isImplementationPlanFile)
      .map(normalizeImplementationSubject),
  )
  const missing = []

  for (const file of files) {
    if (!isCounterPlanFile(file)) continue
    const abs = join(planDir, file)
    if (!isPlanEnforced(abs)) continue
    const subject = normalizeCounterSubject(file)
    if (!implementationSubjects.has(subject)) {
      missing.push({ file, subject })
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      message: '',
      errors: [
        'Plan pairing failed: source changes require each enforced counter-plan/arrangement to have a matching implementation plan.',
        ...missing.map((item) => `- ${PLAN_DIR}/${item.file} -> expected subject "${item.subject}" with an implementation plan`),
        'Fix: add a matching *-implementation.md plan, or add frontmatter `enforce: false` to historical counter material.',
      ],
    }
  }

  return { ok: true, message: 'Plan pairing ok.', errors: [] }
}

function collectChangedFiles(root, explicitBaseRef) {
  const files = new Set()
  const baseRef = explicitBaseRef || resolveBaseRef(root)
  if (baseRef) {
    addGitOutput(files, root, ['diff', '--name-only', `${baseRef}...HEAD`])
  }
  addGitOutput(files, root, ['diff', '--name-only'])
  addGitOutput(files, root, ['diff', '--cached', '--name-only'])
  return [...files].map(normalizePath)
}

function resolveBaseRef(root) {
  try {
    return execGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()
  } catch {
    // No upstream is normal for local worktrees; fall back to main/merge-base.
  }
  try {
    execGit(root, ['rev-parse', '--verify', 'main'])
    return execGit(root, ['merge-base', 'HEAD', 'main']).trim()
  } catch {
    return null
  }
}

function addGitOutput(files, root, args) {
  try {
    for (const line of execGit(root, args).split(/\r?\n/)) {
      const file = line.trim()
      if (file) files.add(file)
    }
  } catch {
    // Best effort: an unavailable ref should not hide explicit worktree diffs.
  }
}

function execGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function isPlanEnforced(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  if (!frontmatter) return true
  return !/^enforce:\s*false\s*(?:#.*)?$/m.test(frontmatter)
}

function isCounterPlanFile(file) {
  return /(?:arrangement|counterplan)\.md$/.test(file)
}

function isImplementationPlanFile(file) {
  return /implementation(?:-plan-claude)?\.md$/.test(file)
}

function normalizeCounterSubject(file) {
  return stripDate(file)
    .replace(/-claude-counterplan\.md$/, '')
    .replace(/-counterplan\.md$/, '')
    .replace(/-arrangement\.md$/, '')
}

function normalizeImplementationSubject(file) {
  return stripDate(file)
    .replace(/-implementation-plan-claude\.md$/, '')
    .replace(/-implementation\.md$/, '')
}

function stripDate(file) {
  return file.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

function isSourceChange(file) {
  return file.startsWith('src/')
    || file.startsWith('eslint-rules/')
    || file.startsWith('scripts/')
}

function parseArgs(argv) {
  const options = { root: process.cwd(), changedFiles: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      options.root = argv[++i]
    } else if (arg === '--base') {
      options.baseRef = argv[++i]
    } else if (arg === '--changed-file') {
      options.changedFiles.push(argv[++i])
    } else if (arg === '--all') {
      options.all = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function normalizePath(file) {
  return String(file || '').replaceAll('\\', '/')
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  checkPlanPairing,
  main,
  resolveBaseRef,
}
