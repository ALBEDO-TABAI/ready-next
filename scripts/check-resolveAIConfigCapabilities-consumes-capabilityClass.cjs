#!/usr/bin/env node
/**
 * Stage S (PR-S5 / W4.0) — resolveAIConfigCapabilities reads from
 * the three-layer merge.
 *
 * Verify (via TS AST) that the body of `resolveAIConfigCapabilities`
 * in `src/shared/ai-providers.ts` references both
 *   - `provider.capabilityClass` (or `provider?.capabilityClass`)
 *   - `*.capabilityOverrides`    (model layer)
 *
 * This is the central contract for PR-S5: the resolver must consult
 * the provider class and the model overrides; otherwise the field
 * extensions from PR-S2 / PR-S3 would be inert.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers.ts'

function checkResolveConsumesCapabilityClass({ root = REPO_DEFAULT } = {}) {
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
      && node.name.text === 'resolveAIConfigCapabilities'
    ) {
      resolverNode = node
      return
    }
    ts.forEachChild(node, findResolver)
  }

  findResolver(sourceFile)

  if (!resolverNode || !resolverNode.body) {
    errors.push('Cannot find function body of resolveAIConfigCapabilities')
    return { ok: false, errors }
  }

  let foundCapabilityClass = false
  let foundCapabilityOverrides = false

  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.name)
    ) {
      if (node.name.text === 'capabilityClass') foundCapabilityClass = true
      if (node.name.text === 'capabilityOverrides') foundCapabilityOverrides = true
    }
    ts.forEachChild(node, visit)
  }

  visit(resolverNode.body)

  if (!foundCapabilityClass) {
    errors.push('resolveAIConfigCapabilities body does not reference `provider(.|?.)capabilityClass`')
  }
  if (!foundCapabilityOverrides) {
    errors.push('resolveAIConfigCapabilities body does not reference `*.capabilityOverrides` (model layer)')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkResolveConsumesCapabilityClass()
  if (!result.ok) {
    console.error('[check-resolveAIConfigCapabilities-consumes-capabilityClass] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-resolveAIConfigCapabilities-consumes-capabilityClass] OK')
}

module.exports = { checkResolveConsumesCapabilityClass }
