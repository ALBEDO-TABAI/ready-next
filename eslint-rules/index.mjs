import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  findingKey,
  normalizeFilePath,
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

function createNoSubagentLeakRule() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'disallow agent-control files outside sub-agent from importing sub-agent internals',
      },
      messages: {
        noSubagentLeak: 'Do not import agent-control/sub-agent from outside the sub-agent boundary during A1.',
      },
      schema: [],
    },
    create(context) {
      const rawFilePath = context.filename && !context.filename.startsWith('<')
        ? context.filename
        : context.physicalFilename
      const filePath = normalizeFilePath(
        isAbsolute(rawFilePath) ? relative(process.cwd(), rawFilePath) : rawFilePath,
      )
      if (!isAgentControlOutsideSubagent(filePath) || isBStageChildSubagentConsumer(filePath)) return {}

      function checkSpecifier(node, specifier) {
        if (typeof specifier !== 'string') return
        if (!importsSubagentDirectory(filePath, specifier)) return
        context.report({
          node,
          messageId: 'noSubagentLeak',
        })
      }

      return {
        ImportDeclaration(node) {
          checkSpecifier(node.source, node.source?.value)
        },
        ExportAllDeclaration(node) {
          checkSpecifier(node.source, node.source?.value)
        },
        ExportNamedDeclaration(node) {
          checkSpecifier(node.source, node.source?.value)
        },
        ImportExpression(node) {
          checkSpecifier(node.source, node.source?.value)
        },
        CallExpression(node) {
          if (node.callee?.type === 'Import') {
            checkSpecifier(node.arguments?.[0], node.arguments?.[0]?.value)
          }
          if (node.callee?.type === 'Identifier' && node.callee.name === 'require') {
            checkSpecifier(node.arguments?.[0], node.arguments?.[0]?.value)
          }
        },
        TSImportEqualsDeclaration(node) {
          if (node.moduleReference?.type === 'TSExternalModuleReference') {
            checkSpecifier(node.moduleReference.expression, node.moduleReference.expression?.value)
          }
        },
      }
    },
  }
}

function isAgentControlOutsideSubagent(filePath) {
  return filePath.startsWith('src/main/modules/agent-control/')
    && !filePath.startsWith('src/main/modules/agent-control/sub-agent/')
}

function isBStageChildSubagentConsumer(filePath) {
  return filePath === 'src/main/modules/agent-control/skill-child-runner.ts'
    || filePath === 'src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts'
    || filePath === 'src/main/modules/agent-control/skill-child-sub-agent.ts'
    || filePath === 'src/main/modules/agent-control/skill-child-sub-agent-factory.ts'
}

function importsSubagentDirectory(filePath, specifier) {
  const spec = normalizeFilePath(specifier)
  if (spec.startsWith('.')) {
    const resolved = normalizeFilePath(relative(process.cwd(), resolve(dirname(filePath), spec)))
    return isSubagentPath(resolved)
  }
  return isSubagentPath(spec) || spec.includes('/agent-control/sub-agent/')
}

function isSubagentPath(path) {
  return path === 'src/main/modules/agent-control/sub-agent'
    || path.startsWith('src/main/modules/agent-control/sub-agent/')
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
  'no-subagent-leak': createNoSubagentLeakRule(),
}

export default {
  rules,
}

export { rules }
