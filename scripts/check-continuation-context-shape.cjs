#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = process.cwd()
const HELPER_REL = 'src/main/modules/agent-control/task-projection/run-budget-policy.ts'
const HELPER_PATH = path.join(ROOT, HELPER_REL)
const violations = []

function listSourceFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__tests__') pending.push(target)
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(target)
      }
    }
  }
  return files
}

if (!fs.existsSync(HELPER_PATH)) {
  violations.push(`${HELPER_REL}: helper_missing`)
} else {
  const helper = fs.readFileSync(HELPER_PATH, 'utf8')
  if (!/projectionBudget\s*:\s*TaskBudget\s*\|\s*null\b/.test(helper)) {
    violations.push(`${HELPER_REL}: projectionBudget required field not declared`)
  }
  if (!/projectionBudgetRuntime\s*:\s*TaskBudgetRuntime\s*\|\s*null\b/.test(helper)) {
    violations.push(`${HELPER_REL}: projectionBudgetRuntime required field not declared`)
  }
}

for (const file of listSourceFiles(path.join(ROOT, 'src/main/modules'))) {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes('restoreContinuationTaskBudgetRuntime')) continue
  const relative = path.relative(ROOT, file).split(path.sep).join('/')
  if (relative === HELPER_REL) continue
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'restoreContinuationTaskBudgetRuntime'
    ) {
      const argument = node.arguments[0]
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        violations.push(`${relative}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: call_missing_object_literal`)
      } else {
        const keys = new Set(argument.properties.flatMap((property) => {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return []
          return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? [property.name.text] : []
        }))
        if (!keys.has('projectionBudget')) {
          violations.push(`${relative}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: call_missing_projection_budget`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (violations.length > 0) {
  console.error('check-continuation-context-shape: violations:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('check-continuation-context-shape: ok')
