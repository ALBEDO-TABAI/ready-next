#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.READY_CHECK_ROOT || process.cwd()
const memoryToolsPath = path.join(root, 'src/main/modules/tools/memory-tools.ts')
const memorySchemasPath = path.join(root, 'src/main/modules/tools/schemas/memory-schemas.ts')

function fail(message) {
  console.error(`[check-model-card-write-staged] ${message}`)
  process.exitCode = 1
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

const memoryTools = read(memoryToolsPath)
const memorySchemas = read(memorySchemasPath)

if (!/resolveCardWriteAuthorization\s*\(/.test(memoryTools)) {
  fail('memory_write_card must call resolveCardWriteAuthorization before writing')
}

if (/status\s*:\s*status\s*(?:\?\?|[,}\n])/.test(memoryTools)) {
  fail('memory_write_card must not pass model supplied status directly into frontmatter')
}

if (/\bconfirmed_active\b/.test(memorySchemas)) {
  fail('confirmed_active must not be exposed in the model-facing memory_write_card schema')
}

if (/\bconfirmed_active\b|\bconfirmedActive\b/.test(memoryTools)) {
  fail('confirmed active must not be read from memory_write_card args or local model-facing inputs')
}

if (process.exitCode) process.exit(process.exitCode)
console.log('[check-model-card-write-staged] ok')
