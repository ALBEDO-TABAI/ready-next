#!/usr/bin/env node
'use strict'

// Structural contract only: behavior is verified by the native storage suite.
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const ts = require('typescript')

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

const owner = parse('src/main/modules/database.ts')
const manager = owner.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'DatabaseManager')
assert.ok(manager, 'DatabaseManager must remain the connection owner')
assert.deepEqual(
  manager.members.filter(ts.isMethodDeclaration).map((node) => node.name.getText(owner)).sort(),
  ['init', 'getRawDb', 'createTables', 'getDatabase', 'close'].sort(),
  'Product methods belong to domain stores, not the connection owner',
)

for (const name of readdirSync('src/main/modules/database').filter((name) => name.endsWith('-store.ts'))) {
  const file = `src/main/modules/database/${name}`
  const source = parse(file)
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.text
      assert.ok(!['../database', 'better-sqlite3', 'electron'].includes(specifier), `${file} must not own a connection or import its manager`)
    }
    if (ts.isPropertyAccessExpression(node)) {
      assert.notEqual(node.name.text, 'close', `${file} must not close the owner's connection`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
console.log('[database-storage-boundaries] OK: connection lifecycle and six domain stores are separate')
