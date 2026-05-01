#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const TESTING_CONVENTIONS_DOC = 'docs/superpowers/testing-conventions.md'
const AGENT_DOCS = ['CLAUDE.md', 'AGENTS.md']
const REQUIRED_ANCHORS = [
  '## 行为测试 vs 结构测试',
  '## __breaksInvariants 协议',
  '## e2e 测试边界',
  '## fixture 提交规约',
  '## 测试运行模式表',
]

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const result = checkTestingConventionsDoc(options)
  if (!result.ok) {
    console.error(result.errors.join('\n'))
    return 1
  }
  console.log(result.message)
  return 0
}

function checkTestingConventionsDoc(options = {}) {
  const root = resolve(options.root || process.cwd())
  const errors = []
  const docPath = join(root, TESTING_CONVENTIONS_DOC)

  if (!existsSync(docPath)) {
    errors.push(`${TESTING_CONVENTIONS_DOC} is missing`)
  } else {
    const doc = readFileSync(docPath, 'utf8')
    for (const anchor of REQUIRED_ANCHORS) {
      if (!doc.includes(anchor)) {
        errors.push(`${TESTING_CONVENTIONS_DOC} missing required anchor: ${anchor}`)
      }
    }
  }

  for (const agentDoc of AGENT_DOCS) {
    const agentDocPath = join(root, agentDoc)
    if (!existsSync(agentDocPath)) {
      errors.push(`${agentDoc} is missing`)
      continue
    }
    const text = readFileSync(agentDocPath, 'utf8')
    if (!/###\s*6\.17\b/.test(text)) {
      errors.push(`${agentDoc} must include ### 6.17`)
    }
    if (!text.includes('testing-conventions.md')) {
      errors.push(`${agentDoc} must reference testing-conventions.md`)
    }
  }

  return {
    ok: errors.length === 0,
    message: 'Testing conventions documentation ok.',
    errors,
  }
}

function parseArgs(argv) {
  const options = { root: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      options.root = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  REQUIRED_ANCHORS,
  checkTestingConventionsDoc,
  main,
}
