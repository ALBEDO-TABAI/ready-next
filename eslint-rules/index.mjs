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

function createNoCoordinatorIdLeakRule() {
  const productIds = new Set(['browser', 'document', 'skill', 'rss', 'calendar', 'feishu'])
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'disallow product adapter id checks in turn-engine',
      },
      messages: {
        noCoordinatorIdLeak: 'Do not compare DomainAdapter id values in turn-engine; move product behavior into the adapter.',
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
      if (filePath !== 'src/main/modules/agent-control/turn-engine.ts') return {}

      function isAdapterIdMember(node) {
        if (node?.type === 'ChainExpression') {
          return isAdapterIdMember(node.expression)
        }
        if (!node || node.type !== 'MemberExpression') return false
        const property = node.property
        return !node.computed && property?.type === 'Identifier' && property.name === 'id'
      }

      function isProductLiteral(node) {
        return node?.type === 'Literal'
          && typeof node.value === 'string'
          && productIds.has(node.value)
      }

      return {
        BinaryExpression(node) {
          if (node.operator !== '===' && node.operator !== '!==') return
          if (
            (isAdapterIdMember(node.left) && isProductLiteral(node.right))
            || (isProductLiteral(node.left) && isAdapterIdMember(node.right))
          ) {
            context.report({
              node,
              messageId: 'noCoordinatorIdLeak',
            })
          }
        },
      }
    },
  }
}

function createNoInlineSystemReminderWriteRule() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'disallow inline system reminder writes outside the reminder registry',
      },
      messages: {
        noInlineSystemReminderWrite: 'Compose system reminders through SystemReminderRegistry instead of writing inline reminder text.',
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
      const inlineReminderIdentifiers = new Set()

      function unwrap(node) {
        let current = node
        while (
          current
          && (
            current.type === 'TSAsExpression'
            || current.type === 'TSTypeAssertion'
            || current.type === 'TSNonNullExpression'
            || current.type === 'ChainExpression'
          )
        ) {
          current = current.expression
        }
        return current
      }

      function stringStartsReminder(text) {
        return /^\s*系统(?:提醒|补充)：/.test(String(text || ''))
      }

      function isReminderLiteral(node, allowIdentifier = true) {
        const unwrapped = unwrap(node)
        if (!unwrapped) return false
        if (unwrapped.type === 'Literal') {
          return typeof unwrapped.value === 'string' && stringStartsReminder(unwrapped.value)
        }
        if (unwrapped.type === 'TemplateLiteral') {
          return stringStartsReminder(unwrapped.quasis?.[0]?.value?.cooked || unwrapped.quasis?.[0]?.value?.raw || '')
        }
        if (allowIdentifier && unwrapped.type === 'Identifier') {
          return inlineReminderIdentifiers.has(unwrapped.name)
        }
        if (unwrapped.type === 'ArrayExpression') {
          return unwrapped.elements.some((element) => element && isReminderLiteral(element, allowIdentifier))
        }
        if (
          unwrapped.type === 'CallExpression'
          && unwrapped.callee?.type === 'MemberExpression'
          && getStaticPropertyName(unwrapped.callee.property, unwrapped.callee.computed) === 'join'
          && isReminderLiteral(unwrapped.callee.object, allowIdentifier)
        ) {
          return true
        }
        if (unwrapped.type === 'BinaryExpression' && unwrapped.operator === '+') {
          return isReminderLiteral(unwrapped.left, allowIdentifier) || isReminderLiteral(unwrapped.right, allowIdentifier)
        }
        return false
      }

      function getStaticPropertyName(property, computed) {
        if (!computed && property?.type === 'Identifier') return property.name
        if (property?.type === 'Literal' && typeof property.value === 'string') return property.value
        return null
      }

      function isSystemReminderProperty(property) {
        if (!property || property.type !== 'Property') return false
        return getStaticPropertyName(property.key, property.computed) === 'systemReminder'
      }

      function getObjectProperty(objectExpression, propertyName) {
        if (!objectExpression || objectExpression.type !== 'ObjectExpression') return null
        return objectExpression.properties.find((property) =>
          property?.type === 'Property'
          && getStaticPropertyName(property.key, property.computed) === propertyName
        ) || null
      }

      function isUserRoleProperty(property) {
        return property
          && property.type === 'Property'
          && unwrap(property.value)?.type === 'Literal'
          && unwrap(property.value)?.value === 'user'
      }

      function isSessionMessagesPush(node) {
        const callee = unwrap(node.callee)
        if (!callee || callee.type !== 'MemberExpression') return false
        if (getStaticPropertyName(callee.property, callee.computed) !== 'push') return false
        const target = unwrap(callee.object)
        if (!target || target.type !== 'MemberExpression') return false
        if (getStaticPropertyName(target.property, target.computed) !== 'messages') return false
        const owner = unwrap(target.object)
        return owner?.type === 'Identifier' && owner.name === 'session'
      }

      function isTestFile() {
        return filePath.includes('/__tests__/') || filePath.startsWith('src/__tests__/')
      }

      return {
        VariableDeclarator(node) {
          if (node.id?.type !== 'Identifier' || !node.init) return
          if (isReminderLiteral(node.init, false)) {
            inlineReminderIdentifiers.add(node.id.name)
          }
        },
        Property(node) {
          if (isTestFile()) return
          if (!isSystemReminderProperty(node)) return
          const value = unwrap(node.value)
          if (value?.type === 'Literal' && value.value === null) return
          if (isReminderLiteral(value)) {
            context.report({
              node: node.value,
              messageId: 'noInlineSystemReminderWrite',
            })
          }
        },
        CallExpression(node) {
          if (filePath !== 'src/main/modules/agent-control/turn-engine.ts') return
          if (!isSessionMessagesPush(node)) return
          const message = unwrap(node.arguments?.[0])
          if (!message || message.type !== 'ObjectExpression') return
          const roleProperty = getObjectProperty(message, 'role')
          if (!isUserRoleProperty(roleProperty)) return
          const contentProperty = getObjectProperty(message, 'content')
          if (contentProperty?.type !== 'Property') return
          if (!isReminderLiteral(contentProperty.value, false)) return
          context.report({
            node: contentProperty.value,
            messageId: 'noInlineSystemReminderWrite',
          })
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
  'no-coordinator-id-leak': createNoCoordinatorIdLeakRule(),
  'no-inline-system-reminder-write': createNoInlineSystemReminderWriteRule(),
}

export default {
  rules,
}

export { rules }
