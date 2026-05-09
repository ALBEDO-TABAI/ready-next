#!/usr/bin/env node
/**
 * Stage S (PR-S7 / W4.5) — `resolveModelCapabilities` merge-order gate.
 *
 * Verifies that `src/shared/ai-providers/model-capability-resolver.ts`
 * exports `resolveModelCapabilities` and that, in its body, each of
 * the three return-object fields uses the canonical `??` chain
 *
 *     modelCap.<field> ?? providerCap.<field> ?? <falseLiteral>
 *
 * which materialises the priority order
 *   model.capabilityOverrides > provider.capabilityClass > false.
 *
 * The gate is a structural check (TypeScript AST) — the matching
 * tsx behaviour test in `model-capability-overrides.test.ts` exercises
 * the priority at runtime against fixture configs.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers/model-capability-resolver.ts'
const REQUIRED_FIELDS = ['supportsVision', 'supportsThinking', 'supportsLongContext']

function checkModelCapabilityResolverMergeOrder({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing target file: ${TARGET_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  const sourceFile = ts.createSourceFile(TARGET_REL, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  let resolverNode = null

  function findResolver(node) {
    if (resolverNode) return
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.name.text === 'resolveModelCapabilities'
    ) {
      resolverNode = node
      return
    }
    ts.forEachChild(node, findResolver)
  }

  findResolver(sourceFile)

  if (!resolverNode || !resolverNode.body) {
    return { ok: false, errors: ['Cannot find function body of resolveModelCapabilities'] }
  }

  // For each canonical field, verify the body has the
  //   modelCap.<field> ?? providerCap.<field> ?? false
  // chain (or a `??` chain whose final argument is `false`).
  // We tolerate whitespace and optional chaining / parens.
  const body = src.slice(resolverNode.body.pos, resolverNode.body.end)

  for (const field of REQUIRED_FIELDS) {
    // Pattern (free-form): modelCap...<field> ?? providerCap...<field> ?? false
    const pattern = new RegExp(
      `modelCap\\??\\.${field}\\s*\\?\\?\\s*providerCap\\??\\.${field}\\s*\\?\\?\\s*false`,
      'm',
    )
    if (!pattern.test(body)) {
      errors.push(`resolveModelCapabilities body must contain canonical merge order for "${field}": modelCap.${field} ?? providerCap.${field} ?? false`)
    }
  }

  // Also confirm the export name is reachable.
  const exportRe = /export\s+function\s+resolveModelCapabilities\b/
  if (!exportRe.test(src)) {
    errors.push('Missing `export function resolveModelCapabilities` declaration')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkModelCapabilityResolverMergeOrder()
  if (!result.ok) {
    console.error('[check-model-capability-resolver-merge-order] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-model-capability-resolver-merge-order] OK')
}

module.exports = { checkModelCapabilityResolverMergeOrder, REQUIRED_FIELDS }
