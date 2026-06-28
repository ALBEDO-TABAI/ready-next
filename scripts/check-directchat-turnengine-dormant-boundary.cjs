#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = process.cwd()
const ORCHESTRATOR_REL = 'src/main/modules/agent-control/runtime-core/orchestrator.ts'
const AGENT_SDK_RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts'
const DIRECT_CHAT_REL = 'src/main/modules/claude-bridge/direct-chat.ts'
const MAIN_ROOT_REL = 'src/main'

function relposix(abs, root = ROOT) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function listTsFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        stack.push(abs)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs)
    }
  }
  return out
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

function pushMatches(errors, rel, text, regex, kind) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  let match
  while ((match = re.exec(text))) {
    errors.push(`${kind}:${rel}:${lineOf(text, match.index)}`)
  }
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function moduleBase(specifier) {
  return specifier.replace(/\.[mc]?[jt]sx?$/, '').split('/').pop()
}

function findImports(text, baseName) {
  const imports = []
  const sourceFile = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (moduleBase(node.moduleSpecifier.text) === baseName) {
        const statement = node.getText(sourceFile)
        imports.push({
          statement,
          index: node.getStart(sourceFile),
          typeOnly: Boolean(node.importClause?.isTypeOnly),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
}

function defaultImportLocal(statement) {
  const head = statement
    .replace(/^import\s+type\s+/, '')
    .replace(/^import\s+/, '')
    .replace(/\s+from\s+['"][^'"]+['"]\s*$/, '')
    .trim()
  if (head.startsWith('{') || head.startsWith('*')) return null
  const local = head.split(',')[0]?.trim()
  return /^[A-Za-z_$][\w$]*$/.test(local) ? local : null
}

function namedImportLocals(statement, importedName) {
  const match = statement.match(/\{([\s\S]*?)\}/)
  if (!match) return []
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^type\s+/, '').trim())
    .map((part) => {
      const alias = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (!alias || alias[1] !== importedName) return null
      return alias[2] || alias[1]
    })
    .filter(Boolean)
}

function namespaceImportLocal(statement) {
  const match = statement.match(/import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/)
  return match?.[1] || null
}

function importAliases(imports, importedName, { includeTypeOnly = false } = {}) {
  const aliases = new Set([importedName])
  const namespaces = new Set()
  for (const entry of imports) {
    if (entry.typeOnly && !includeTypeOnly) continue
    for (const local of namedImportLocals(entry.statement, importedName)) aliases.add(local)
    const defaultLocal = defaultImportLocal(entry.statement)
    if (defaultLocal) aliases.add(defaultLocal)
    const namespaceLocal = namespaceImportLocal(entry.statement)
    if (namespaceLocal) namespaces.add(namespaceLocal)
  }
  return { aliases, namespaces }
}

function moduleSpecifierExpression(baseName) {
  return `['"](?:[^'"]*/)?${escapeRegex(baseName)}['"]`
}

function dynamicImportAliases(text, baseName, importedName) {
  const aliases = new Set()
  const namespaces = new Set()
  const specExpr = moduleSpecifierExpression(baseName)
  const destructureRe = new RegExp(
    `\\b(?:const|let|var)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*${specExpr}\\s*\\)`,
    'g',
  )
  let match
  while ((match = destructureRe.exec(text))) {
    for (const part of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const local = part.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/)
      if (!local || local[1] !== importedName) continue
      aliases.add(local[2] || local[1])
    }
  }
  const namespaceRe = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*${specExpr}\\s*\\)`,
    'g',
  )
  while ((match = namespaceRe.exec(text))) namespaces.add(match[1])
  return { aliases, namespaces }
}

function findRuntimeDynamicImports(text, baseName) {
  const entries = []
  const seen = new Set()
  const sourceFile = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
    ) {
      const specifier = node.arguments[0]
      if (ts.isStringLiteralLike(specifier) && moduleBase(specifier.text) === baseName) {
        const index = node.getStart(sourceFile)
        if (!seen.has(index)) {
          seen.add(index)
          entries.push({ index })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return entries
}

function mergeAliasGroups(...groups) {
  const aliases = new Set()
  const namespaces = new Set()
  for (const group of groups) {
    for (const alias of group.aliases) aliases.add(alias)
    for (const namespace of group.namespaces) namespaces.add(namespace)
  }
  return { aliases, namespaces }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function classExpression({ aliases, namespaces }, importedName) {
  const parts = [...aliases].map(escapeRegex)
  for (const namespace of namespaces) {
    parts.push(`${escapeRegex(namespace)}\\.${escapeRegex(importedName)}`)
  }
  return parts.join('|')
}

function collectConstructedInstanceNames(text, classExpr) {
  const names = new Set()
  if (!classExpr) return names
  const localRe = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+(?:${classExpr})\\s*\\(`, 'g')
  let match
  while ((match = localRe.exec(text))) names.add(match[1])
  const memberRe = new RegExp(`\\bthis\\.([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+(?:${classExpr})\\s*\\(`, 'g')
  while ((match = memberRe.exec(text))) names.add(match[1])
  return names
}

function collectTypedInstanceNames(text, typeExpr) {
  const names = new Set()
  if (!typeExpr) return names
  const re = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*:\\s*(?:${typeExpr})\\b`, 'g')
  let match
  while ((match = re.exec(text))) names.add(match[1])
  return names
}

function collectInlineImportTypedInstanceNames(text, baseName, importedName) {
  const names = new Set()
  const specExpr = moduleSpecifierExpression(baseName)
  const re = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*:\\s*import\\s*\\(\\s*${specExpr}\\s*\\)\\s*\\.\\s*${escapeRegex(importedName)}\\b`,
    'g',
  )
  let match
  while ((match = re.exec(text))) names.add(match[1])
  return names
}

function collectTypeAliasNames(text, typeExpr) {
  const names = new Set()
  if (!typeExpr) return names
  const re = new RegExp(`\\btype\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${typeExpr})\\b`, 'g')
  let match
  while ((match = re.exec(text))) names.add(match[1])
  return names
}

function collectInlineImportTypeAliasNames(text, baseName, importedName) {
  const names = new Set()
  const specExpr = moduleSpecifierExpression(baseName)
  const re = new RegExp(
    `\\btype\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*import\\s*\\(\\s*${specExpr}\\s*\\)\\s*\\.\\s*${escapeRegex(importedName)}\\b`,
    'g',
  )
  let match
  while ((match = re.exec(text))) names.add(match[1])
  return names
}

function expandTypeAliases(text, baseGroup, baseName, importedName) {
  const expanded = {
    aliases: new Set(baseGroup.aliases),
    namespaces: new Set(baseGroup.namespaces),
  }
  let changed = true
  while (changed) {
    changed = false
    const typeExpr = classExpression(expanded, importedName)
    const aliasNames = new Set([
      ...collectTypeAliasNames(text, typeExpr),
      ...collectInlineImportTypeAliasNames(text, baseName, importedName),
    ])
    for (const alias of aliasNames) {
      if (expanded.aliases.has(alias)) continue
      expanded.aliases.add(alias)
      changed = true
    }
  }
  return expanded
}

function pushImportErrors(errors, rel, text, imports, kind) {
  for (const entry of imports) {
    errors.push(`${kind}:${rel}:${lineOf(text, entry.index)}`)
  }
}

function pushConstructErrors(errors, rel, text, classExpr, kind) {
  if (!classExpr) return
  pushMatches(errors, rel, text, new RegExp(`\\bnew\\s+(?:${classExpr})\\s*\\(`), kind)
}

function pushInstanceCallErrors(errors, rel, text, names, method, kind) {
  if (names.size === 0) return
  const nameExpr = [...names].map(escapeRegex).join('|')
  const methodExpr = escapeRegex(method)
  pushMatches(
    errors,
    rel,
    text,
    new RegExp(`\\b(?:this\\.)?(?:${nameExpr})(?:\\?\\.${methodExpr}|\\.${methodExpr}|\\?\\.\\s*\\[\\s*['"]${methodExpr}['"]\\s*\\]|\\s*\\[\\s*['"]${methodExpr}['"]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`),
    kind,
  )
}

function pushNonSdkSendMessageErrors(errors, rel, text) {
  if (rel === DIRECT_CHAT_REL) return
  const patterns = [
    /\.sendMessage\s*(?:\?\.\s*)?\(/g,
    /\[\s*['"]sendMessage['"]\s*\]\s*(?:\?\.\s*)?\(/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(text))) {
      const before = text.slice(Math.max(0, match.index - 48), match.index)
      if (rel === ORCHESTRATOR_REL && /this\.sdkEngine\s*$/.test(before)) continue
      // V3 Phase 5-B: AgentSdkRuntime delegates to its own turn orchestrator (still the SDK path).
      if (rel === AGENT_SDK_RUNTIME_REL && /this\.turnOrchestrator\s*$/.test(before)) continue
      errors.push(`production_calls_non_sdk_sendMessage:${rel}:${lineOf(text, match.index)}`)
    }
  }
}

function isLiteralName(node, expected) {
  if (!node) return false
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text === expected
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text === expected
  if (ts.isComputedPropertyName(node)) {
    const expr = node.expression
    return ts.isStringLiteral(expr) && expr.text === expected
  }
  return false
}

function isThisPropertyAssignment(node, expected) {
  if (!ts.isBinaryExpression(node)) return false
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  const left = node.left
  if (ts.isPropertyAccessExpression(left)) {
    return left.expression.kind === ts.SyntaxKind.ThisKeyword && left.name.text === expected
  }
  if (ts.isElementAccessExpression(left)) {
    const argument = left.argumentExpression
    return left.expression.kind === ts.SyntaxKind.ThisKeyword
      && !!argument
      && ts.isStringLiteral(argument)
      && argument.text === expected
  }
  return false
}

function isThisSendMessageAssignment(node) {
  return isThisPropertyAssignment(node, 'sendMessage')
}

function pushDirectChatAstSendMessageErrors(errors, source) {
  const sourceFile = ts.createSourceFile(DIRECT_CHAT_REL, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const pushAt = (kind, node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    errors.push(`${kind}:${DIRECT_CHAT_REL}:${line}`)
  }
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DirectChatEngine') {
      for (const member of node.members) {
        if ('name' in member && isLiteralName(member.name, 'sendMessage')) {
          pushAt('direct_chat_declares_sendMessage', member)
        }
        if (ts.isConstructorDeclaration(member)) {
          const visitConstructor = (child) => {
            if (isThisSendMessageAssignment(child)) {
              pushAt('direct_chat_declares_sendMessage', child)
            }
            ts.forEachChild(child, visitConstructor)
          }
          ts.forEachChild(member, visitConstructor)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function pushDirectChatAstMemberErrors(errors, source, expectedNames, kind) {
  const sourceFile = ts.createSourceFile(DIRECT_CHAT_REL, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const expected = new Set(expectedNames)
  const pushAt = (node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    errors.push(`${kind}:${DIRECT_CHAT_REL}:${line}`)
  }
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DirectChatEngine') {
      for (const member of node.members) {
        if ('name' in member) {
          for (const name of expected) {
            if (isLiteralName(member.name, name)) {
              pushAt(member)
              break
            }
          }
        }
        if (ts.isConstructorDeclaration(member)) {
          const visitConstructor = (child) => {
            for (const name of expected) {
              if (isThisPropertyAssignment(child, name)) {
                pushAt(child)
                break
              }
            }
            ts.forEachChild(child, visitConstructor)
          }
          ts.forEachChild(member, visitConstructor)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function check({ root = ROOT } = {}) {
  const errors = []
  const orchestratorPath = path.join(root, ORCHESTRATOR_REL)
  const directChatPath = path.join(root, DIRECT_CHAT_REL)

  if (!fs.existsSync(orchestratorPath)) {
    errors.push(`missing_orchestrator:${ORCHESTRATOR_REL}`)
  } else {
    const source = read(root, ORCHESTRATOR_REL)
    if (!/this\.sdkEngine\.sendMessage\s*\(/.test(source)) {
      errors.push('orchestrator_missing_sdk_sendMessage')
    }
    pushMatches(
      errors,
      ORCHESTRATOR_REL,
      source,
      /this\.domainAdapterEngine\.sendMessage\s*\(/,
      'orchestrator_calls_domain_adapter_sendMessage',
    )
    pushMatches(
      errors,
      ORCHESTRATOR_REL,
      source,
      /this\.bindEngineEvents\s*\(\s*this\.domainAdapterEngine\s*\)/,
      'orchestrator_binds_domain_adapter_events',
    )
    pushMatches(
      errors,
      ORCHESTRATOR_REL,
      source,
      /this\.domainAdapterEngine\.setRendererToolActionRequester\s*\(/,
      'orchestrator_forwards_renderer_tool_action_requester_to_direct_chat',
    )
    pushMatches(
      errors,
      ORCHESTRATOR_REL,
      source,
      /this\.domainAdapterEngine\.setCancelPendingToolActions\s*\(/,
      'orchestrator_forwards_tool_action_canceller_to_direct_chat',
    )
  }

  if (!fs.existsSync(directChatPath)) {
    errors.push(`missing_direct_chat:${DIRECT_CHAT_REL}`)
  } else {
    const source = stripComments(read(root, DIRECT_CHAT_REL))
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /import\s+[\s\S]*?\s+from\s+['"](?:node:)?events['"]/,
      'direct_chat_imports_events_module',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /class\s+DirectChatEngine\s+extends\s+(?:[A-Za-z_$][\w$]*\.)?EventEmitter\b/,
      'direct_chat_extends_event_emitter',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bthis\.emit\s*\(\s*['"](?:output|status|error|toolAction)['"]/,
      'direct_chat_emits_renderer_event',
    )
    const turnEngineImports = findImports(source, 'turn-engine')
    const turnEngineRuntimeDynamicImports = findRuntimeDynamicImports(source, 'turn-engine')
    if (turnEngineImports.length > 0) {
      pushImportErrors(errors, DIRECT_CHAT_REL, source, turnEngineImports, 'direct_chat_imports_turn_engine_class')
    }
    if (turnEngineRuntimeDynamicImports.length > 0) {
      pushImportErrors(
        errors,
        DIRECT_CHAT_REL,
        source,
        turnEngineRuntimeDynamicImports,
        'direct_chat_dynamic_imports_turn_engine_module',
      )
    }
    pushDirectChatAstSendMessageErrors(errors, source)
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /private\s+readonly\s+turnEngine\b/,
      'direct_chat_declares_turn_engine_member',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bthis\.turnEngine\b/,
      'direct_chat_references_turn_engine_member',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\b(?:async\s+)?sendMessage\s*(?:<[^>{}]+>)?\s*\(/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\[\s*['"]sendMessage['"]\s*\]\s*(?:<[^>{}]+>)?\s*\(/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bsendMessage\s*(?::[\s\S]{0,240}?)?=\s*(?:async\s*)?/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bfunction\s+sendMessage\s*(?:<[^>{}]+>)?\s*\(/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\[\s*['"]sendMessage['"]\s*\]\s*(?::[\s\S]{0,240}?)?=\s*(?:async\s*)?/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bthis\s*\[\s*['"]sendMessage['"]\s*\]\s*=\s*(?:async\s*)?/,
      'direct_chat_declares_sendMessage',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bnew\s+TurnEngine\s*\(/,
      'direct_chat_constructs_turn_engine',
    )
    if (/this\.turnEngine\.execute\s*\(/.test(source)) {
      errors.push(`direct_chat_calls_turn_engine_execute:${DIRECT_CHAT_REL}`)
    }
    const executionLoopImports = findImports(source, 'execution-loop-orchestrator')
    const executionLoopRuntimeDynamicImports = findRuntimeDynamicImports(source, 'execution-loop-orchestrator')
    if (executionLoopImports.length > 0) {
      pushImportErrors(errors, DIRECT_CHAT_REL, source, executionLoopImports, 'direct_chat_imports_execution_loop_orchestrator')
    }
    if (executionLoopRuntimeDynamicImports.length > 0) {
      pushImportErrors(
        errors,
        DIRECT_CHAT_REL,
        source,
        executionLoopRuntimeDynamicImports,
        'direct_chat_dynamic_imports_execution_loop_orchestrator',
      )
    }
    const hostCapabilityImports = findImports(source, 'host-capability-dispatcher')
    const hostCapabilityRuntimeDynamicImports = findRuntimeDynamicImports(source, 'host-capability-dispatcher')
    if (hostCapabilityImports.length > 0) {
      pushImportErrors(errors, DIRECT_CHAT_REL, source, hostCapabilityImports, 'direct_chat_imports_host_capability_dispatcher')
    }
    if (hostCapabilityRuntimeDynamicImports.length > 0) {
      pushImportErrors(
        errors,
        DIRECT_CHAT_REL,
        source,
        hostCapabilityRuntimeDynamicImports,
        'direct_chat_dynamic_imports_host_capability_dispatcher',
      )
    }
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bnew\s+(?:ExecutionLoopOrchestrator|[A-Za-z_$][\w$]*\.ExecutionLoopOrchestrator)\s*\(/,
      'direct_chat_constructs_execution_loop_orchestrator',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bnew\s+(?:HostCapabilityDispatcher|[A-Za-z_$][\w$]*\.HostCapabilityDispatcher)\s*\(/,
      'direct_chat_constructs_host_capability_dispatcher',
    )
    pushDirectChatAstMemberErrors(
      errors,
      source,
      ['executionLoopOrchestrator'],
      'direct_chat_declares_execution_loop_orchestrator_member',
    )
    pushDirectChatAstMemberErrors(
      errors,
      source,
      ['hostCapabilityDispatcher'],
      'direct_chat_declares_host_capability_dispatcher_member',
    )
    pushDirectChatAstMemberErrors(
      errors,
      source,
      ['requestSimpleText'],
      'direct_chat_declares_requestSimpleText',
    )
    pushDirectChatAstMemberErrors(
      errors,
      source,
      ['requestToolLoopResponse'],
      'direct_chat_declares_requestToolLoopResponse',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bthis\.executionLoopOrchestrator(?:\?\.|\.)requestToolLoopResponse\s*(?:\?\.\s*)?\(/,
      'direct_chat_calls_execution_loop_orchestrator_requestToolLoopResponse',
    )
    pushMatches(
      errors,
      DIRECT_CHAT_REL,
      source,
      /\bthis\.hostCapabilityDispatcher(?:\?\.|\.)dispatch\s*(?:\?\.\s*)?\(/,
      'direct_chat_calls_host_capability_dispatcher_dispatch',
    )
  }

  const mainRoot = path.join(root, MAIN_ROOT_REL)
  if (fs.existsSync(mainRoot)) {
    for (const abs of listTsFiles(mainRoot)) {
      const rel = relposix(abs, root)
	      if (rel.includes('/__tests__/')) continue
	      const source = fs.readFileSync(abs, 'utf8')
	      const searchable = stripComments(source)
	      const turnEngineImports = findImports(searchable, 'turn-engine')
	      const turnEngineRuntimeDynamicImports = findRuntimeDynamicImports(searchable, 'turn-engine')
	      const directChatImports = findImports(searchable, 'direct-chat')
	      const directChatRuntimeDynamicImports = findRuntimeDynamicImports(searchable, 'direct-chat')

	      const turnEngineAliases = mergeAliasGroups(
	        importAliases(turnEngineImports, 'TurnEngine', { includeTypeOnly: true }),
	        dynamicImportAliases(searchable, 'turn-engine', 'TurnEngine'),
	      )
	      const turnEngineClassExpr = classExpression(turnEngineAliases, 'TurnEngine')
	      const turnEngineInstances = collectConstructedInstanceNames(searchable, turnEngineClassExpr)
	      const turnEngineTypeAliases = expandTypeAliases(searchable, turnEngineAliases, 'turn-engine', 'TurnEngine')
	      const turnEngineTypeExpr = classExpression(turnEngineTypeAliases, 'TurnEngine')
	      const turnEngineTypedInstances = new Set([
	        ...collectTypedInstanceNames(searchable, turnEngineTypeExpr),
	        ...collectInlineImportTypedInstanceNames(searchable, 'turn-engine', 'TurnEngine'),
	      ])
	      const turnEngineishNames = new Set([...turnEngineInstances, ...turnEngineTypedInstances])
	      const turnEngineishRe = /\b(?:[A-Za-z_$][\w$]*(?:turnEngine|TurnEngine)[A-Za-z_$\w]*|turnEngine|TurnEngine)\b/g
	      let nameMatch
	      while ((nameMatch = turnEngineishRe.exec(searchable))) turnEngineishNames.add(nameMatch[0])

	      const directChatAliases = mergeAliasGroups(
	        importAliases(directChatImports, 'DirectChatEngine'),
	        dynamicImportAliases(searchable, 'direct-chat', 'DirectChatEngine'),
	      )
	      const directChatClassExpr = classExpression(directChatAliases, 'DirectChatEngine')
	      const directChatInstances = collectConstructedInstanceNames(searchable, directChatClassExpr)
	      const directChatTypeAliases = expandTypeAliases(
	        searchable,
	        mergeAliasGroups(
	          importAliases(directChatImports, 'DirectChatEngine', { includeTypeOnly: true }),
	          dynamicImportAliases(searchable, 'direct-chat', 'DirectChatEngine'),
	        ),
	        'direct-chat',
	        'DirectChatEngine',
	      )
	      const directChatTypeExpr = classExpression(directChatTypeAliases, 'DirectChatEngine')
	      const directChatTypedInstances = new Set([
	        ...collectTypedInstanceNames(searchable, directChatTypeExpr),
	        ...collectInlineImportTypedInstanceNames(searchable, 'direct-chat', 'DirectChatEngine'),
	      ])
	      const directChatishNames = new Set([...directChatInstances, ...directChatTypedInstances, 'domainAdapterEngine'])
	      const directChatishRe = /\b(?:[A-Za-z_$][\w$]*(?:directChat|DirectChat)[A-Za-z_$\w]*|directChat|DirectChat)\b/g
	      while ((nameMatch = directChatishRe.exec(searchable))) directChatishNames.add(nameMatch[0])

	      if (rel !== DIRECT_CHAT_REL) {
	        pushImportErrors(errors, rel, searchable, turnEngineImports, 'production_imports_turn_engine_class')
	        pushImportErrors(
	          errors,
	          rel,
	          searchable,
	          turnEngineRuntimeDynamicImports,
	          'production_dynamic_imports_turn_engine_module',
	        )
	        pushConstructErrors(errors, rel, searchable, turnEngineClassExpr, 'production_constructs_turn_engine')
        pushMatches(
          errors,
          rel,
          searchable,
          new RegExp(`\\bnew\\s+(?:${turnEngineClassExpr})\\s*\\(\\s*\\)(?:\\?\\.execute|\\.execute|\\?\\.\\s*\\[\\s*['"]execute['"]\\s*\\]|\\s*\\[\\s*['"]execute['"]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`),
          'production_calls_turn_engine_execute',
        )
	        pushInstanceCallErrors(
	          errors,
	          rel,
	          searchable,
	          turnEngineishNames,
	          'execute',
	          'production_calls_turn_engine_execute',
	        )
	      }
	      if (rel !== DIRECT_CHAT_REL && rel !== ORCHESTRATOR_REL) {
	        const runtimeDirectChatImports = directChatImports.filter((entry) => !entry.typeOnly)
	        const importsDirectChatEngine = runtimeDirectChatImports.filter((entry) => {
	          if (namespaceImportLocal(entry.statement)) return true
	          return namedImportLocals(entry.statement, 'DirectChatEngine').length > 0 || defaultImportLocal(entry.statement)
	        })
	        pushImportErrors(errors, rel, searchable, importsDirectChatEngine, 'production_imports_direct_chat_engine')
	        pushImportErrors(
	          errors,
	          rel,
	          searchable,
	          directChatRuntimeDynamicImports,
	          'production_dynamic_imports_direct_chat_module',
	        )
	        pushConstructErrors(errors, rel, searchable, directChatClassExpr, 'production_constructs_direct_chat_engine')
	      }
	      if (rel !== DIRECT_CHAT_REL) {
	        pushNonSdkSendMessageErrors(errors, rel, searchable)
        pushMatches(
          errors,
          rel,
          searchable,
          new RegExp(`\\bnew\\s+(?:${directChatClassExpr})\\s*\\(\\s*\\)(?:\\?\\.sendMessage|\\.sendMessage|\\?\\.\\s*\\[\\s*['"]sendMessage['"]\\s*\\]|\\s*\\[\\s*['"]sendMessage['"]\\s*\\])\\s*(?:\\?\\.\\s*)?\\(`),
          'production_calls_direct_chat_sendMessage',
        )
	        pushInstanceCallErrors(
	          errors,
	          rel,
	          searchable,
	          directChatishNames,
	          'sendMessage',
	          'production_calls_direct_chat_sendMessage',
	        )
	        pushMatches(
	          errors,
	          rel,
	          searchable,
	          /\bdomainAdapterEngine\.sendMessage\s*\(/,
	          'production_calls_domain_adapter_sendMessage',
	        )
	      }
	    }
	  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-directchat-turnengine-dormant-boundary] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-directchat-turnengine-dormant-boundary] OK')
}

module.exports = { check }
