#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_DIRS = ['src/main', 'src/preload', 'src/renderer']
const ALLOWED_REGISTRY_CREATE = new Set([
  'src/main/modules/agent-control/agents/agent-factory.ts',
])
const ALLOWED_BLUEPRINT_WRITE = new Set([
  'src/main/modules/agent-control/agents/agent-factory.ts',
  'src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts',
  'src/main/modules/agent-control/agents/specialist-blueprint-store.ts',
  'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts',
  'src/main/modules/claude-bridge/ipc/agent-derivation-group.ts',
  'src/main/modules/tools/builtins/confirm-specialist-blueprint.ts',
  'src/main/modules/tools/builtins/propose-specialist-blueprint.ts',
  'src/preload/index.ts',
  'src/renderer/types/electron.d.ts',
])
const ALLOWED_SEMANTIC_REVIEW_CALL = new Set([
  'src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts',
  'src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts',
  'src/main/modules/tools/builtins/propose-specialist-blueprint.ts',
])
const ALLOWED_SEMANTIC_REVIEW_CALL_COUNT = new Map([
  ['src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts', 1],
  ['src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts', 1],
  ['src/main/modules/tools/builtins/propose-specialist-blueprint.ts', 1],
])
const ALLOWED_SEMANTIC_JUDGE_RESOLVER_CALL = new Set([
  'src/main/modules/agent-control/agents/specialist-foundation-semantic-judge-provider.ts',
  'src/main/modules/claude-bridge/ipc-handler.ts',
  'src/main/modules/tools/tool-executor.ts',
])
const ALLOWED_SEMANTIC_JUDGE_RESOLVER_CALL_COUNT = new Map([
  ['src/main/modules/agent-control/agents/specialist-foundation-semantic-judge-provider.ts', 1],
  ['src/main/modules/claude-bridge/ipc-handler.ts', 1],
  ['src/main/modules/tools/tool-executor.ts', 1],
])
const ALLOWED_DIRECT_DERIVATION_CALL = new Set([
  'src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts',
])
const ALLOWED_CHAT_CREATE_SURFACE = new Set([
  'src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts',
  'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts',
  'src/main/modules/tools/builtins/confirm-specialist-blueprint.ts',
  'src/main/modules/tools/schemas/agent-interaction-schemas.ts',
])

function fail(message) {
  console.error(`[check-specialist-create-funnel] FAIL: ${message}`)
  process.exit(1)
}

function listFiles(dir) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(next)
      } else if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(entry.name)) {
        out.push(next)
      }
    }
  }
  walk(abs)
  return out
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length
}

const files = SCAN_DIRS.flatMap(listFiles)
const registryCreateViolations = []
const directDerivationViolations = []
const legacyDerivationImportViolations = []
const blueprintWriteViolations = []
const chatCreateChannelViolations = []
const foundationPromptViolations = []
const semanticPromptViolations = []
const semanticIssueEnumViolations = []
const semanticHashHelperViolations = []
const semanticReviewCallViolations = []
const semanticResolverCallViolations = []
const bareSourceMessageNullViolations = []

const REGISTRY_CREATE_RE = /(?:\bregistry|\bagentRegistry|\bgetAgentRegistry\(\)|\.getAgentRegistry\(\))\.create\s*\(/
const DIRECT_DERIVATION_RE = /\b(?:deriveSpecialistAgent|prepareSpecialistAgentDerivation)\s*\(/
const BLUEPRINT_WRITE_RE = /(?:\.upsert\s*\(|write(?:File|Card|Blueprint)|insert(?:Blueprint|SpecialistBlueprint)|upsert(?:Blueprint|SpecialistBlueprint))/
const LEGACY_DERIVATION_IMPORT_RE = /\b(?:import|export)\s*{[^}]*\b(?:deriveSpecialistAgent|prepareSpecialistAgentDerivation)\b[^}]*}\s*from\s*['"][^'"]*agent-factory['"]/
const P5E_LEGACY_DERIVATION_MARKER = 'P5e/C23 legacy dormant derivation path'

function extractFunctionBody(source, functionName) {
  const signatureIndex = source.indexOf(`export function ${functionName}`)
  if (signatureIndex < 0) return null
  const openIndex = source.indexOf('{', signatureIndex)
  if (openIndex < 0) return null
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, index + 1)
    }
  }
  return null
}

function assertMarkerNearFunction(source, functionName) {
  const signatureIndex = source.indexOf(`export function ${functionName}`)
  if (signatureIndex < 0) {
    fail(`legacy specialist derivation helper must remain explicit and marked: ${functionName}`)
  }
  const nearby = source.slice(Math.max(0, signatureIndex - 320), signatureIndex + 120)
  if (!nearby.includes(P5E_LEGACY_DERIVATION_MARKER)) {
    fail(`legacy specialist derivation helper must carry P5e dormant marker: ${functionName}`)
  }
}

for (const file of files) {
  const relative = rel(file)
  const source = fs.readFileSync(file, 'utf8')
  if (REGISTRY_CREATE_RE.test(source) && !ALLOWED_REGISTRY_CREATE.has(relative)) {
    registryCreateViolations.push(relative)
  }
  if (DIRECT_DERIVATION_RE.test(source)
    && relative !== 'src/main/modules/agent-control/agents/agent-factory.ts'
    && !ALLOWED_DIRECT_DERIVATION_CALL.has(relative)) {
    directDerivationViolations.push(relative)
  }
  if (LEGACY_DERIVATION_IMPORT_RE.test(source)
    && relative !== 'src/main/modules/agent-control/agents/agent-factory.ts'
    && !ALLOWED_DIRECT_DERIVATION_CALL.has(relative)) {
    legacyDerivationImportViolations.push(relative)
  }
  if (/agent:(?:specialist|blueprint):(?:create|confirm)|confirmSpecialistBlueprint|createSpecialistBlueprint/.test(source)
    && !ALLOWED_CHAT_CREATE_SURFACE.has(relative)) {
    chatCreateChannelViolations.push(relative)
  }
  if (BLUEPRINT_WRITE_RE.test(source)
    && /SpecialistAgentBlueprint|specialist blueprint|blueprintStore|getBlueprintStore\(\)|upsertSpecialistBlueprint|insertSpecialistBlueprint|writeBlueprint/i.test(source)
    && relative !== 'src/shared/agent-specialist-blueprint.ts'
    && !ALLOWED_BLUEPRINT_WRITE.has(relative)) {
    blueprintWriteViolations.push(relative)
  }
  if (relative === 'src/main/modules/agent-control/prompt-assembly.ts' && /FOUNDATION\.md/.test(source)) {
    foundationPromptViolations.push(relative)
  }
  if (relative === 'src/main/modules/agent-control/prompt-assembly.ts' && /semanticReview/.test(source)) {
    semanticPromptViolations.push(relative)
  }
  if (/SPECIALIST_FOUNDATION_SEMANTIC_ISSUES\s*=/.test(source)
    && relative !== 'src/shared/agent-specialist-blueprint.ts') {
    semanticIssueEnumViolations.push(relative)
  }
  const semanticHashScope = /semanticReview|SpecialistFoundation|foundation-semantic|specialist-foundation-semantic/.test(`${relative}\n${source}`)
  if (semanticHashScope
    && /createHash\s*\(/.test(source)
    && /^src\/main\/modules\/agent-control\/agents\/specialist-/.test(relative)
    && relative !== 'src/main/modules/agent-control/agents/specialist-blueprint-review-content.ts') {
    semanticHashHelperViolations.push(relative)
  }
  const semanticReviewCallCount = countMatches(source, /\brunSpecialistFoundationSemanticReview\s*\(/g)
  if (semanticReviewCallCount > 0 && !ALLOWED_SEMANTIC_REVIEW_CALL.has(relative)) {
    semanticReviewCallViolations.push(relative)
  }
  if (semanticReviewCallCount > (ALLOWED_SEMANTIC_REVIEW_CALL_COUNT.get(relative) || 0)) {
    semanticReviewCallViolations.push(`${relative}(${semanticReviewCallCount})`)
  }
  const semanticResolverCallCount = countMatches(source, /\bresolveSpecialistFoundationSemanticJudge\s*\(/g)
  if (semanticResolverCallCount > 0 && !ALLOWED_SEMANTIC_JUDGE_RESOLVER_CALL.has(relative)) {
    semanticResolverCallViolations.push(relative)
  }
  if (semanticResolverCallCount > (ALLOWED_SEMANTIC_JUDGE_RESOLVER_CALL_COUNT.get(relative) || 0)) {
    semanticResolverCallViolations.push(`${relative}(${semanticResolverCallCount})`)
  }
  const nullMatches = source.matchAll(/sourceMessageId:\s*null/g)
  for (const match of nullMatches) {
    const index = match.index ?? 0
    const nearby = source.slice(index, index + 240)
    if (!/sourceMessageUnavailableReason/.test(nearby)) {
      bareSourceMessageNullViolations.push(relative)
      break
    }
  }
}

if (registryCreateViolations.length > 0) {
  fail(`specialist registry.create is only allowed through agent-factory.ts: ${registryCreateViolations.join(', ')}`)
}
if (directDerivationViolations.length > 0) {
  fail(`legacy specialist derivation functions are only callable inside agent-factory.ts: ${directDerivationViolations.join(', ')}`)
}
if (legacyDerivationImportViolations.length > 0) {
  fail(`legacy specialist derivation helpers must not be imported or re-exported in production code: ${legacyDerivationImportViolations.join(', ')}`)
}
if (chatCreateChannelViolations.length > 0) {
  fail(`chat-driven specialist creation IPC is deferred to P8c/P8f: ${chatCreateChannelViolations.join(', ')}`)
}
if (blueprintWriteViolations.length > 0) {
  fail(`specialist blueprint persistence is deferred to P8c/P8f: ${blueprintWriteViolations.join(', ')}`)
}
if (foundationPromptViolations.length > 0) {
  fail(`FOUNDATION.md is a review artifact and must not be prompt-injected: ${foundationPromptViolations.join(', ')}`)
}
if (semanticPromptViolations.length > 0) {
  fail(`semanticReview is review metadata and must not be prompt-injected: ${semanticPromptViolations.join(', ')}`)
}
if (semanticIssueEnumViolations.length > 0) {
  fail(`semantic issue enum must be defined only in shared blueprint schema: ${semanticIssueEnumViolations.join(', ')}`)
}
if (semanticHashHelperViolations.length > 0) {
  fail(`specialist semantic review hash must use specialist-blueprint-review-content.ts helper: ${semanticHashHelperViolations.join(', ')}`)
}
if (semanticReviewCallViolations.length > 0) {
  fail(`specialist semantic review runner may only be called by blueprint propose/admission paths: ${semanticReviewCallViolations.join(', ')}`)
}
if (semanticResolverCallViolations.length > 0) {
  fail(`specialist semantic judge resolver may only be wired by propose dispatch and specialist blueprint IPC: ${semanticResolverCallViolations.join(', ')}`)
}
if (bareSourceMessageNullViolations.length > 0) {
  fail(`specialist blueprint provenance cannot write bare sourceMessageId:null without sourceMessageUnavailableReason: ${bareSourceMessageNullViolations.join(', ')}`)
}

const groupPath = path.join(ROOT, 'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts')
const confirmationHelperPath = path.join(ROOT, 'src/main/modules/agent-control/agents/specialist-blueprint-confirm-create.ts')
if (fs.existsSync(groupPath) && fs.existsSync(confirmationHelperPath)) {
  const groupSource = fs.readFileSync(groupPath, 'utf8')
  const confirmationSource = fs.readFileSync(confirmationHelperPath, 'utf8')
  if (!/requestSpecialistBlueprintConfirmationForCreate/.test(groupSource)
    || !/confirmSpecialistBlueprintCreateWithToken/.test(groupSource)) {
    fail('specialist confirmation IPC must delegate to the shared confirm/create helper')
  }
  if (!/materializeSpecialistBlueprintForReview/.test(confirmationSource)
    || !/hashSpecialistBlueprintReviewContent/.test(confirmationSource)
    || !/acceptsSpecialistBlueprintSemanticReview/.test(confirmationSource)) {
    fail('specialist confirmation helper must use canonical review materialization, shared hash helper, and semantic acceptance check')
  }
  if (!/isCurrentSemanticBlock/.test(confirmationSource) || !/review\?\.\s*status\s*===\s*'blocked'/.test(confirmationSource)) {
    fail('specialist confirmation helper must preserve current semantic blocked reviews for the same content hash')
  }
  if (!/semanticFoundationJudgeUnavailableReason/.test(confirmationSource)) {
    fail('specialist confirmation helper must carry observable semantic judge unavailable reasons')
  }
}

const semanticJudgePath = path.join(ROOT, 'src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts')
if (fs.existsSync(semanticJudgePath)) {
  const semanticJudgeSource = fs.readFileSync(semanticJudgePath, 'utf8')
  if (!/materializeSpecialistBlueprintForReview/.test(semanticJudgeSource)
    || !/hashSpecialistBlueprintReviewContent/.test(semanticJudgeSource)
    || !/isSpecialistFoundationSemanticIssueId/.test(semanticJudgeSource)) {
    fail('specialist semantic judge must use canonical review materialization, shared hash helper, and closed shared issue ids')
  }
}

const ipcHandlerPath = path.join(ROOT, 'src/main/modules/claude-bridge/ipc-handler.ts')
if (fs.existsSync(ipcHandlerPath)) {
  const ipcHandlerSource = fs.readFileSync(ipcHandlerPath, 'utf8')
  if (!/resolveSpecialistFoundationSemanticJudge/.test(ipcHandlerSource)
    || !/runSemanticFoundationJudge:\s*specialistSemanticJudge\.judge/.test(ipcHandlerSource)
    || !/semanticFoundationJudgeUnavailableReason:\s*specialistSemanticJudge\.unavailableReason/.test(ipcHandlerSource)) {
    fail('specialist blueprint IPC registration must wire the production semantic judge resolver')
  }
}

const toolExecutorPath = path.join(ROOT, 'src/main/modules/tools/tool-executor.ts')
if (fs.existsSync(toolExecutorPath)) {
  const toolExecutorSource = fs.readFileSync(toolExecutorPath, 'utf8')
  if (/sourceMessageId:\s*null/.test(toolExecutorSource)) {
    fail('propose_specialist_blueprint dispatch must not hardcode bare sourceMessageId: null')
  }
  if (!/resolveSpecialistFoundationSemanticJudge/.test(toolExecutorSource)
    || !/semanticFoundationJudgeUnavailableReason:\s*\w+\.unavailableReason/.test(toolExecutorSource)
    || !/sourceMessageUnavailableReason/.test(toolExecutorSource)) {
    fail('propose_specialist_blueprint dispatch must wire semantic judge resolver and message provenance reason')
  }
}

const derivationGroupPath = path.join(ROOT, 'src/main/modules/claude-bridge/ipc/agent-derivation-group.ts')
if (fs.existsSync(derivationGroupPath)) {
  const derivationGroupSource = fs.readFileSync(derivationGroupPath, 'utf8')
  if (/deriveSpecialistAgent|prepareSpecialistAgentDerivation/.test(derivationGroupSource)) {
    fail('legacy derivation IPC must not import or call legacy specialist derivation helpers')
  }
  if (/registry\.create\s*\(/.test(derivationGroupSource)) {
    fail('legacy derivation IPC must not create specialist agent rows directly')
  }
  if (!/createdAgent:\s*false/.test(derivationGroupSource)
    || !/routingActivated:\s*false/.test(derivationGroupSource)
    || !/migratedCards:\s*\[\s*\]/.test(derivationGroupSource)) {
    fail('legacy derivation IPC confirm must remain blueprint-staging only')
  }
}

const factoryPath = path.join(ROOT, 'src/main/modules/agent-control/agents/agent-factory.ts')
if (fs.existsSync(factoryPath)) {
  const factorySource = fs.readFileSync(factoryPath, 'utf8')
  assertMarkerNearFunction(factorySource, 'prepareSpecialistAgentDerivation')
  assertMarkerNearFunction(factorySource, 'deriveSpecialistAgent')

  const blueprintBody = extractFunctionBody(factorySource, 'deriveSpecialistAgentFromBlueprint')
  if (!blueprintBody) {
    fail('live blueprint specialist creation path must remain in agent-factory.ts')
  }
  if (/\b(?:deriveSpecialistAgent|prepareSpecialistAgentDerivation)\s*\(/.test(blueprintBody)) {
    fail('live blueprint specialist creation must not delegate to legacy derivation helpers')
  }
  const registryCreateIndex = blueprintBody.indexOf('const agent = registry.create')
  const routingWriteIndex = blueprintBody.indexOf('const routing = store.writeCard')
  const catchIndex = blueprintBody.indexOf('catch (error)')
  if (routingWriteIndex < 0 || registryCreateIndex < 0 || registryCreateIndex < routingWriteIndex) {
    fail('live blueprint specialist creation must write routing/assets before registry.create')
  }
  if (catchIndex < 0
    || blueprintBody.indexOf('rollbackMigratedCards(store, migratedCards)', catchIndex) < 0
    || blueprintBody.indexOf('createdRelPaths.reverse()', catchIndex) < 0
    || blueprintBody.indexOf('createdDirPaths.reverse()', catchIndex) < 0
    || blueprintBody.indexOf('rmSync(absInside(store.rootPath, relPath)', catchIndex) < 0) {
    fail('live blueprint specialist creation must keep rollback cleanup for migrated cards, files, and dirs')
  }
}

console.log('[check-specialist-create-funnel] OK')
