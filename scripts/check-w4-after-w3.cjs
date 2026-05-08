#!/usr/bin/env node
/**
 * Stage S (PR-S5 / W4.0) — W4 must land after W3.
 *
 * Three preconditions plus one body check:
 *   (a) PR-S3 has run — `src/shared/ai-providers/` directory and the
 *       7 provider sub-modules exist (W3.1 outcome).
 *   (b) PR-S2 type extensions are intact — `AIProviderDef.capabilityClass?:`
 *       and `AIModelDef.capabilityOverrides?:` are still declared.
 *   (c) `AIResolvedCapabilities` still requires `supportsThinking: boolean`
 *       and `supportsLongContext: boolean` (no `?:`).
 *   (d) The body of `resolveAIConfigCapabilities` must contain all three
 *       merge expressions: `visionDefault`, `thinkingDefault`,
 *       `longContextDefault` (or any equivalent identifiers that read
 *       `capabilityOverrides` then `capabilityClass`). To keep the
 *       gate cheap and resilient to renames we accept any line that
 *       chains `capabilityOverrides ??` and `capabilityClass ??`
 *       within a 4-line window.
 *
 * Pattern after `check-coordinator-isolation.cjs` (TS AST + literal
 * window scan).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers.ts'

const PROVIDER_FILES = [
  'moonshot.ts',
  'anthropic.ts',
  'fox.ts',
  'openai.ts',
  'gemini.ts',
  'volcengine.ts',
  'openai-compatible.ts',
]

function checkW4AfterW3({ root = REPO_DEFAULT } = {}) {
  const errors = []

  // (a) PR-S3 has run.
  const subDir = path.join(root, 'src/shared/ai-providers')
  if (!fs.existsSync(subDir)) {
    errors.push('PR-S3 precondition: src/shared/ai-providers/ directory missing — W4 must land after W3')
  } else {
    for (const file of PROVIDER_FILES) {
      const abs = path.join(subDir, file)
      if (!fs.existsSync(abs)) {
        errors.push(`PR-S3 precondition: missing src/shared/ai-providers/${file}`)
      }
    }
  }

  // (b) PR-S2 type extensions intact.
  const targetAbs = path.join(root, TARGET_REL)
  if (!fs.existsSync(targetAbs)) {
    errors.push(`Missing target: ${TARGET_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(targetAbs, 'utf8')

  const providerDefMatch = src.match(/export\s+interface\s+AIProviderDef\s*\{[\s\S]*?\n\}/)
  if (!providerDefMatch) {
    errors.push('AIProviderDef interface block not found')
  } else if (!/\bcapabilityClass\?\s*:/.test(providerDefMatch[0])) {
    errors.push('PR-S2 precondition: AIProviderDef.capabilityClass?: missing')
  }

  const modelDefMatch = src.match(/export\s+interface\s+AIModelDef\s*\{[\s\S]*?\n\}/)
  if (!modelDefMatch) {
    errors.push('AIModelDef interface block not found')
  } else if (!/\bcapabilityOverrides\?\s*:/.test(modelDefMatch[0])) {
    errors.push('PR-S2 precondition: AIModelDef.capabilityOverrides?: missing')
  }

  // (c) AIResolvedCapabilities still requires the two flags.
  const resolvedMatch = src.match(/export\s+interface\s+AIResolvedCapabilities\s*\{[\s\S]*?\n\}/)
  if (!resolvedMatch) {
    errors.push('AIResolvedCapabilities interface block not found')
  } else {
    for (const fieldName of ['supportsThinking', 'supportsLongContext']) {
      const requiredRe = new RegExp(`\\b${fieldName}\\s*:\\s*boolean\\b`)
      const optionalRe = new RegExp(`\\b${fieldName}\\?\\s*:`)
      if (optionalRe.test(resolvedMatch[0])) {
        errors.push(`AIResolvedCapabilities.${fieldName} must remain required (\`${fieldName}: boolean\`)`)
      } else if (!requiredRe.test(resolvedMatch[0])) {
        errors.push(`AIResolvedCapabilities is missing required field \`${fieldName}: boolean\``)
      }
    }
  }

  // (d) Function body references both merge layers.
  const sourceFile = ts.createSourceFile(TARGET_REL, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let resolverNode = null
  function findResolver(node) {
    if (resolverNode) return
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.name.text === 'resolveAIConfigCapabilities'
    ) {
      resolverNode = node
      return
    }
    ts.forEachChild(node, findResolver)
  }
  findResolver(sourceFile)

  if (!resolverNode || !resolverNode.body) {
    errors.push('Cannot find resolveAIConfigCapabilities body')
  } else {
    const bodyText = src.slice(resolverNode.body.getStart(sourceFile), resolverNode.body.getEnd())
    if (!/capabilityClass/.test(bodyText)) {
      errors.push('resolveAIConfigCapabilities body does not mention `capabilityClass`')
    }
    if (!/capabilityOverrides/.test(bodyText)) {
      errors.push('resolveAIConfigCapabilities body does not mention `capabilityOverrides`')
    }
    // Three default expressions for the three flags. Accept either the
    // canonical names or any pattern that chains the two layers via `??`.
    const hasMergeChain = /capabilityOverrides[\s\S]*?\?\?[\s\S]*?capabilityClass/.test(bodyText)
      || (/visionDefault/.test(bodyText) && /thinkingDefault/.test(bodyText) && /longContextDefault/.test(bodyText))
    if (!hasMergeChain) {
      errors.push('resolveAIConfigCapabilities body does not chain `capabilityOverrides ?? capabilityClass ?? <fallback>`')
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkW4AfterW3()
  if (!result.ok) {
    console.error('[check-w4-after-w3] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-w4-after-w3] OK')
}

module.exports = { checkW4AfterW3 }
