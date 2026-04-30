import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  findingKey,
  RULE_IDS,
  scanRuleViolations,
} from './a0-rule-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baselinePath = resolve(__dirname, 'baseline.json')
const baselineKeys = loadBaselineKeys()

function loadBaselineKeys() {
  if (!existsSync(baselinePath)) return new Set()
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
  return new Set(entries.map((entry) => `${entry.file}|${entry.rule}|${entry.snippetHash}`))
}

function createBaselineAwareRule(rule, meta) {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: meta.description,
      },
      messages: {
        [meta.messageId]: meta.message,
      },
      schema: [],
    },
    create(context) {
      const rawFilePath = context.physicalFilename || context.filename
      const filePath = isAbsolute(rawFilePath)
        ? relative(process.cwd(), rawFilePath)
        : rawFilePath
      return {
        Program(node) {
          const sourceText = context.sourceCode.getText()
          const findings = scanRuleViolations({
            filePath,
            sourceText,
            rule,
            honorReviewedDisables: false,
          })
          for (const finding of findings) {
            if (baselineKeys.has(findingKey(finding))) continue
            context.report({
              node,
              loc: {
                line: finding.line,
                column: Math.max(0, finding.column - 1),
              },
              messageId: finding.messageId,
            })
          }
        },
      }
    },
  }
}

const rules = {
  'no-source-grep-test': createBaselineAwareRule(RULE_IDS.sourceGrep, {
    description: 'disallow readFileSync source-grep assertions in tests',
    messageId: 'noSourceGrepTest',
    message: 'Do not assert source-code text with readFileSync; use a behavior test instead.',
  }),
  'no-legacy-backdoor': createBaselineAwareRule(RULE_IDS.legacyBackdoor, {
    description: 'disallow new legacy backdoor switches in runtime code',
    messageId: 'noLegacyBackdoor',
    message: 'Do not add legacy conditionals or optional legacy switches without an explicit reviewed exemption.',
  }),
  'no-migration-todo': createBaselineAwareRule(RULE_IDS.migrationTodo, {
    description: 'disallow migration TODO placeholders in runtime code',
    messageId: 'noMigrationTodo',
    message: 'Do not add migration TODO placeholders; file a staged plan or remove the TODO.',
  }),
}

export default {
  rules,
}

export { rules }
