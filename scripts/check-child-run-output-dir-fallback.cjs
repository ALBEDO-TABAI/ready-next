#!/usr/bin/env node

const { readFileSync } = require('node:fs')
const { relative, resolve } = require('node:path')

const DEFAULT_SOURCE = 'src/main/modules/agent-control/skill-child-runner.ts'

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = checkChildRunOutputDirFallback(options)
    if (result.violations.length > 0) {
      console.error('child-run outputDir fallback check failed:')
      for (const violation of result.violations) {
        console.error(`- ${violation.file} ${violation.message}`)
      }
      process.exit(1)
    }
    console.log('child-run outputDir fallback: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..'),
    source: DEFAULT_SOURCE,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error(usage('Missing value for --root.'))
      options.root = resolve(value)
      index += 1
    } else if (arg === '--source') {
      const value = argv[index + 1]
      if (!value) throw new Error(usage('Missing value for --source.'))
      options.source = value
      index += 1
    } else {
      throw new Error(usage(`Unknown argument "${arg}".`))
    }
  }
  return options
}

function usage(message) {
  return [
    message,
    'Usage: node scripts/check-child-run-output-dir-fallback.cjs [--root <path>] [--source <path>]',
  ].join('\n')
}

function checkChildRunOutputDirFallback({
  root = resolve(__dirname, '..'),
  source = DEFAULT_SOURCE,
} = {}) {
  const rootDir = resolve(root)
  const sourcePath = resolve(rootDir, source)
  const text = readFileSync(sourcePath, 'utf8')
  const file = normalizePath(relative(rootDir, sourcePath))
  const violations = []

  if (!text.includes('resolveCanonicalChildRunHandle')) {
    violations.push({ file, message: 'skill-child-runner must use resolveCanonicalChildRunHandle before deriving outputDir' })
  }
  if (!text.includes('isResumeOnlySkillAction(params.skillId, params.action)')) {
    violations.push({ file, message: 'resume-only actions must be checked before runtime outputDir fabrication' })
  }
  if (/params\.requestedInput\.outputDir/.test(text)) {
    violations.push({ file, message: 'runner must not read params.requestedInput.outputDir directly; use canonical handle input' })
  }
  if (
    /requestedOutputDir\s*\|\|\s*join\([^)]*outputsRoot/.test(text)
    && !/!canonicalHandle\.ok\s*&&\s*isResumeOnlySkillAction\(params\.skillId,\s*params\.action\)/.test(text)
  ) {
    violations.push({ file, message: 'runtime outputsRoot fallback must be guarded away from resume-only actions' })
  }

  return { violations }
}

function normalizePath(value) {
  return value.split('\\').join('/')
}

module.exports = {
  checkChildRunOutputDirFallback,
}
