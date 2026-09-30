#!/usr/bin/env node
'use strict'
// Read the actual registry, including imported literal names, without executing migrations.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function readMigrationNumbers(file) {
  const cache = new Map()
  const parse = (name) => {
    if (!cache.has(name)) cache.set(name, ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true))
    return cache.get(name)
  }
  const declarations = (source) => source.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
  const literal = (node, owner) => {
    if (ts.isStringLiteral(node)) return node.text
    if (!ts.isIdentifier(node)) throw new Error('Migration names must be static strings or imported literal constants.')
    const source = parse(owner)
    const local = declarations(source).find((declaration) => declaration.name.getText(source) === node.text)
    if (local?.initializer && ts.isStringLiteral(local.initializer)) return local.initializer.text
    for (const statement of source.statements.filter(ts.isImportDeclaration)) {
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings) || !statement.moduleSpecifier.text.startsWith('.')) continue
      const binding = bindings.elements.find((entry) => entry.name.text === node.text)
      if (!binding) continue
      const imported = path.resolve(path.dirname(owner), statement.moduleSpecifier.text + '.ts')
      const importedName = (binding.propertyName || binding.name).text
      const declaration = declarations(parse(imported)).find((entry) => entry.name.getText() === importedName)
      if (declaration?.initializer && ts.isStringLiteral(declaration.initializer)) return declaration.initializer.text
    }
    throw new Error(`Unresolved migration name: ${node.text}`)
  }
  const source = parse(file)
  const registry = declarations(source).find((entry) => entry.name.getText(source) === 'migrations')?.initializer
  if (!registry || !ts.isArrayLiteralExpression(registry)) throw new Error('Missing static migrations registry.')
  return registry.elements.map((entry) => {
    if (!ts.isObjectLiteralExpression(entry)) throw new Error('Unsupported migration registry entry.')
    const name = entry.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === 'name')
    if (!name) throw new Error('Migration entry has no name.')
    const value = literal(name.initializer, file)
    const match = value.match(/^(\d{3})_[A-Za-z0-9_]+$/)
    if (!match) throw new Error(`Invalid migration name: ${value}`)
    return Number(match[1])
  })
}

function sequenceErrors(numbers) {
  const errors = []
  if (!numbers.length || numbers[0] !== 1) errors.push('Migrations must start at 001.')
  for (let index = 1; index < numbers.length; index++) {
    if (numbers[index] !== numbers[index - 1] + 1) errors.push(`Non-sequential migrations: ${numbers[index - 1]} → ${numbers[index]}`)
  }
  return errors
}

if (require.main === module) {
  try {
    const numbers = readMigrationNumbers(path.resolve('src/main/modules/migrations.ts'))
    const errors = sequenceErrors(numbers)
    for (const required of [34, 35, 36]) if (!numbers.includes(required)) errors.push(`Required migration ${required} is missing.`)
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(`[check-migration-numbering-sequential] OK (${numbers.length} migrations, range ${numbers[0]}–${numbers.at(-1)})`)
  } catch (error) {
    console.error(`[check-migration-numbering-sequential] FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
module.exports = { readMigrationNumbers, sequenceErrors }
