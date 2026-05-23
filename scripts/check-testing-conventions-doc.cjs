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

// Per Stage Y plan §6.3: CLAUDE.md / AGENTS.md use a flat §0-§12 structure
// after the post-Stage-T reorg. The §6 testing-and-verification section is
// the live carrier of the testing-conventions contract.
const TESTING_SECTION_HEADER = '## 6. 测试与验证'

// Per Stage Y plan §6.3 r3 amplification: assert the testing-convention
// substance is present in BOTH CLAUDE.md and AGENTS.md §6 paragraphs.
// Each invariant offers a small set of equivalent substrings; matching ANY
// substring satisfies the invariant.
const SECTION_INVARIANTS = [
  {
    id: 'verify-native',
    description: 'SQLite-backed tests must require `npm run verify:native`',
    anyOf: ['npm run verify:native', 'verify:native'],
  },
  {
    id: 'no-source-grep',
    description: '"no source-grep 冒充行为验证" rule',
    anyOf: ['不得用 source-grep', 'source-grep'],
  },
  {
    id: 'no-skip-as-pass',
    description: '"no skip 当通过" rule',
    anyOf: ['不得用 skip', 'skip 当通过'],
  },
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

  const sections = {}
  for (const agentDoc of AGENT_DOCS) {
    const agentDocPath = join(root, agentDoc)
    if (!existsSync(agentDocPath)) {
      errors.push(`${agentDoc} is missing`)
      continue
    }
    const text = readFileSync(agentDocPath, 'utf8')

    if (!text.includes(TESTING_SECTION_HEADER)) {
      errors.push(`${agentDoc} must include ${TESTING_SECTION_HEADER}`)
      continue
    }

    if (!text.includes('testing-conventions.md')) {
      errors.push(`${agentDoc} must reference testing-conventions.md`)
    }

    const section = extractSection(text, TESTING_SECTION_HEADER)
    if (!section) {
      errors.push(`${agentDoc} ${TESTING_SECTION_HEADER} body could not be extracted`)
      continue
    }
    sections[agentDoc] = section

    for (const invariant of SECTION_INVARIANTS) {
      const matched = invariant.anyOf.some((needle) =>
        section.toLowerCase().includes(needle.toLowerCase()),
      )
      if (!matched) {
        errors.push(
          `${agentDoc} ${TESTING_SECTION_HEADER} missing invariant "${invariant.id}" (${invariant.description}); expected one of: ${invariant.anyOf.join(' | ')}`,
        )
      }
    }
  }

  // Per CLAUDE.md §12 + AGENTS.md §12: substance must stay in sync.
  if (sections['CLAUDE.md'] && sections['AGENTS.md']) {
    const claudeNormalized = normalizeForSync(sections['CLAUDE.md'])
    const agentsNormalized = normalizeForSync(sections['AGENTS.md'])
    if (claudeNormalized !== agentsNormalized) {
      errors.push(
        `CLAUDE.md and AGENTS.md ${TESTING_SECTION_HEADER} substance diverged; per CLAUDE.md §12 they must stay in sync. ` +
          `Normalized CLAUDE.md length=${claudeNormalized.length}, AGENTS.md length=${agentsNormalized.length}.`,
      )
    }
  }

  return {
    ok: errors.length === 0,
    message: 'Testing conventions documentation ok.',
    errors,
  }
}

// Returns the substring from `header` (inclusive) to the next top-level
// `## ` header (exclusive). Returns null if `header` is not present.
function extractSection(text, header) {
  const startIndex = text.indexOf(header)
  if (startIndex === -1) {
    return null
  }
  const afterHeaderIndex = startIndex + header.length
  // Find the next top-level `## ` header on its own line.
  const remainder = text.slice(afterHeaderIndex)
  const nextMatch = remainder.search(/\n## \S/)
  const endIndex =
    nextMatch === -1 ? text.length : afterHeaderIndex + nextMatch
  return text.slice(startIndex, endIndex)
}

// Collapse whitespace + drop punctuation that should not count as substantive
// divergence. Per §6.3: "more than just whitespace/punctuation".
function normalizeForSync(section) {
  return section
    .replace(/\s+/g, ' ')
    .replace(/[，。；：、,.;:!?！？]/g, '')
    .trim()
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
  SECTION_INVARIANTS,
  TESTING_SECTION_HEADER,
  checkTestingConventionsDoc,
  extractSection,
  normalizeForSync,
  main,
}
