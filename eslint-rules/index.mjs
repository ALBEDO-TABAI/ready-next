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
        allowSourceGrepMissingReason: 'allow-source-grep comments must include a product reason.',
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

function createTestHelperMustDeclareInvariantBreachRule() {
  const helperNamePattern = /^__(reset|seed|stub|forceFlush|breakOpen)\w*ForTests?$/

  function unwrapMarkerExpression(node) {
    let current = node
    while (
      current
      && (
        current.type === 'TSAsExpression'
        || current.type === 'TSTypeAssertion'
        || current.type === 'TSNonNullExpression'
      )
    ) {
      current = current.expression
    }
    return current
  }

  function isFunctionLike(node) {
    return node
      && (
        node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression'
      )
  }

  function isTrueLiteral(node) {
    const unwrapped = unwrapMarkerExpression(node)
    return unwrapped?.type === 'Literal' && unwrapped.value === true
  }

  function getArrayExpression(node) {
    const unwrapped = unwrapMarkerExpression(node)
    return unwrapped?.type === 'ArrayExpression' ? unwrapped : null
  }

  function getIdentifierName(node) {
    return node?.type === 'Identifier' ? node.name : null
  }

  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'require exported test helpers that break production invariants to declare their invariant marker',
      },
      messages: {
        testHelperMustDeclareInvariantBreach: 'Exported test helper must declare a non-empty __breaksInvariants marker, or export __noProductionInvariantBreach = true.',
        testHelperInvariantBreachMarkerEmpty: '__breaksInvariants must list at least one invariant; use __noProductionInvariantBreach = true when no production invariant is broken.',
        testHelperInvariantBreachMarkerConflict: 'Do not export both __breaksInvariants and __noProductionInvariantBreach; choose the marker that matches this module.',
      },
      schema: [],
    },
    create(context) {
      function collectModuleFacts(program) {
        const exportedNames = new Set()
        const functionNames = new Set()
        const variableInits = new Map()
        const variableNodes = new Map()

        function recordVariableDeclarator(declarator) {
          const name = getIdentifierName(declarator.id)
          if (!name) return
          variableInits.set(name, declarator.init)
          variableNodes.set(name, declarator.id)
          if (isFunctionLike(declarator.init)) {
            functionNames.add(name)
          }
        }

        function recordDeclaration(declaration, exported) {
          if (!declaration) return
          if (declaration.type === 'FunctionDeclaration') {
            const name = getIdentifierName(declaration.id)
            if (!name) return
            functionNames.add(name)
            if (exported) exportedNames.add(name)
            return
          }
          if (declaration.type === 'VariableDeclaration') {
            for (const declarator of declaration.declarations) {
              const name = getIdentifierName(declarator.id)
              recordVariableDeclarator(declarator)
              if (exported && name) exportedNames.add(name)
            }
          }
        }

        for (const statement of program.body) {
          if (statement.type === 'FunctionDeclaration' || statement.type === 'VariableDeclaration') {
            recordDeclaration(statement, false)
            continue
          }
          if (statement.type === 'ExportNamedDeclaration') {
            recordDeclaration(statement.declaration, true)
            for (const specifier of statement.specifiers || []) {
              const localName = getIdentifierName(specifier.local)
              if (localName) exportedNames.add(localName)
            }
            continue
          }
          if (statement.type === 'ExportDefaultDeclaration') {
            const declaration = statement.declaration
            if (declaration?.type === 'FunctionDeclaration') {
              const name = getIdentifierName(declaration.id)
              if (name) {
                functionNames.add(name)
                exportedNames.add(name)
              }
            }
          }
        }

        return { exportedNames, functionNames, variableInits, variableNodes }
      }

      return {
        Program(node) {
          const {
            exportedNames,
            functionNames,
            variableInits,
            variableNodes,
          } = collectModuleFacts(node)
          const helperNames = Array.from(exportedNames).filter((name) =>
            helperNamePattern.test(name) && functionNames.has(name)
          )
          const hasBreaksMarker = exportedNames.has('__breaksInvariants')
            && variableInits.has('__breaksInvariants')
          const hasNoBreachMarker = exportedNames.has('__noProductionInvariantBreach')
            && variableInits.has('__noProductionInvariantBreach')
          const breaksMarkerArray = hasBreaksMarker
            ? getArrayExpression(variableInits.get('__breaksInvariants'))
            : null
          const breaksMarkerNode = variableNodes.get('__breaksInvariants') || node
          const noBreachMarkerNode = variableNodes.get('__noProductionInvariantBreach') || node

          if (hasBreaksMarker && hasNoBreachMarker) {
            context.report({
              node: noBreachMarkerNode,
              messageId: 'testHelperInvariantBreachMarkerConflict',
            })
            return
          }

          if (breaksMarkerArray && breaksMarkerArray.elements.every((element) => !element)) {
            context.report({
              node: breaksMarkerNode,
              messageId: 'testHelperInvariantBreachMarkerEmpty',
            })
            return
          }

          if (helperNames.length === 0) return

          const hasNonEmptyBreaksMarker = Boolean(
            breaksMarkerArray && breaksMarkerArray.elements.some((element) => element),
          )
          const hasLiteralNoBreachMarker = hasNoBreachMarker
            && isTrueLiteral(variableInits.get('__noProductionInvariantBreach'))

          if (hasNonEmptyBreaksMarker || hasLiteralNoBreachMarker) return

          for (const name of helperNames) {
            context.report({
              node: variableNodes.get(name) || node,
              messageId: 'testHelperMustDeclareInvariantBreach',
            })
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
  // Sanctioned child-run ownership boundary. These four modules implement
  // the parent→sub-agent bridge for skill child runs, so they are permitted
  // to import from `agent-control/sub-agent/`. Stage U5.1a2 (commit
  // d7897542) relocated all four files from `agent-control/` into
  // `agent-control/skills/` as a [move-only] refactor; the allowlist tracks
  // the post-move paths. Any new path on either side requires renewed
  // boundary review — do not silently extend.
  return filePath === 'src/main/modules/agent-control/skills/skill-child-runner.ts'
    || filePath === 'src/main/modules/agent-control/skills/skill-child-sub-agent-close-mapping.ts'
    || filePath === 'src/main/modules/agent-control/skills/skill-child-sub-agent.ts'
    || filePath === 'src/main/modules/agent-control/skills/skill-child-sub-agent-factory.ts'
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

/**
 * Stage 6 L6 — `ready/no-task-card-run-cast`.
 *
 * Forbids cast/local-decl forms that bypass the `TaskCardRun` brand-protected
 * factory. Caught patterns:
 *   - `as TaskCardRun`, `<TaskCardRun>x` (direct/identifier)
 *   - `as Foo.TaskCardRun` (namespace qualifier)
 *   - `as TaskCardRun[]`, `as Array<TaskCardRun>`, `as ReadonlyArray<TaskCardRun>`,
 *     `as readonly TaskCardRun[]`, `as Set/Map/Promise<TaskCardRun>`,
 *     `as [TaskCardRun, ...]` (array/container/tuple)
 *   - `as import('...').TaskCardRun` (inline import type)
 *   - `import { TaskCardRun as TCR }` (aliased import)
 *   - `type X = TaskCardRun`, `interface TaskCardRun {}`, `type TaskCardRun = ...`
 *     outside the helper file (local-decl bypass)
 *
 * Helper file allowlist: `src/renderer/components/agent/task-card-from-projection.ts`.
 *
 * Acknowledged remaining gaps (deliberate laundering, out of scope):
 *   `Pick<TaskCardRun, 'taskId'>`, `TaskCardRun & {}`, `TaskCardRun | null`,
 *   `as any as TaskCardRun`. These require active intent to bypass.
 */
const TASK_CARD_HELPER_PATH = 'src/renderer/components/agent/task-card-from-projection.ts'
const CONTAINER_TYPE_NAMES = new Set([
  'Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Map', 'ReadonlyMap', 'Promise',
])

function createNoTaskCardRunCastRule() {
  return {
    meta: {
      type: 'problem',
      docs: { description: 'forbid cast/local-decl bypass of the TaskCardRun brand-protected factory' },
      schema: [],
      messages: {
        cast: 'TaskCardRun cast bypasses the sealed factory; use taskProjectionToTaskCardRun()',
        aliasImport: 'Import TaskCardRun without renaming; alias bypass forbidden outside helper',
        localAlias: 'Local type alias of TaskCardRun is forbidden outside helper file',
        importType: 'Inline import type referencing TaskCardRun is forbidden outside helper',
        localInterface: 'Local declaration of TaskCardRun is forbidden outside helper file; import the brand-protected type from task-card-from-projection.ts',
      },
    },
    create(context) {
      const filename = (context.getFilename ? context.getFilename() : '').replace(/\\/g, '/')
      if (filename.endsWith(`/${TASK_CARD_HELPER_PATH}`) || filename === TASK_CARD_HELPER_PATH) return {}

      function isTaskCardRef(typeNode) {
        if (!typeNode) return false
        if (typeNode.type === 'TSTypeOperator') return isTaskCardRef(typeNode.typeAnnotation)
        if (typeNode.type === 'TSRestType') return isTaskCardRef(typeNode.typeAnnotation)
        if (typeNode.type === 'TSArrayType') return isTaskCardRef(typeNode.elementType)
        if (typeNode.type === 'TSTupleType') return (typeNode.elementTypes || []).some(isTaskCardRef)
        if (typeNode.type === 'TSTypeReference') {
          const tn = typeNode.typeName
          if (tn?.type === 'Identifier' && tn.name === 'TaskCardRun') return true
          if (tn?.type === 'TSQualifiedName' && tn.right?.name === 'TaskCardRun') return true
          if (tn?.type === 'Identifier' && CONTAINER_TYPE_NAMES.has(tn.name)) {
            const args = typeNode.typeArguments?.params || typeNode.typeParameters?.params || []
            return args.some(isTaskCardRef)
          }
        }
        if (typeNode.type === 'TSImportType') {
          const q = typeNode.qualifier
          if (q?.type === 'Identifier' && q.name === 'TaskCardRun') return true
          if (q?.type === 'TSQualifiedName' && q.right?.name === 'TaskCardRun') return true
        }
        return false
      }

      return {
        TSInterfaceDeclaration(node) {
          if (node.id?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'localInterface' })
          }
        },
        TSTypeAliasDeclaration(node) {
          if (node.id?.name === 'TaskCardRun') {
            context.report({ node, messageId: 'localInterface' })
            return
          }
          if (isTaskCardRef(node.typeAnnotation)) {
            context.report({ node, messageId: 'localAlias' })
          }
        },
        ImportDeclaration(node) {
          for (const spec of node.specifiers || []) {
            if (spec.type !== 'ImportSpecifier') continue
            const imported = spec.imported?.name
            const local = spec.local?.name
            if (imported === 'TaskCardRun' && local && local !== imported) {
              context.report({ node: spec, messageId: 'aliasImport' })
            }
          }
        },
        TSAsExpression(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const messageId = node.typeAnnotation?.type === 'TSImportType' ? 'importType' : 'cast'
            context.report({ node, messageId })
          }
        },
        TSTypeAssertion(node) {
          if (isTaskCardRef(node.typeAnnotation)) {
            const messageId = node.typeAnnotation?.type === 'TSImportType' ? 'importType' : 'cast'
            context.report({ node, messageId })
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
  'no-subagent-leak': createNoSubagentLeakRule(),
  'no-coordinator-id-leak': createNoCoordinatorIdLeakRule(),
  'no-inline-system-reminder-write': createNoInlineSystemReminderWriteRule(),
  'no-task-card-run-cast': createNoTaskCardRunCastRule(),
  'test-helper-must-declare-invariant-breach': createTestHelperMustDeclareInvariantBreachRule(),
}

export default {
  rules,
}

export { rules }
