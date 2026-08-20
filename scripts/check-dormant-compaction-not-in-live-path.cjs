#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SDK_RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts'
const MAIN_ROOT_REL = 'src/main'

const SDK_FORBIDDEN_IMPORTS = [
  'context-compression',
]

const CONTEXT_COMPRESSION_ALLOWED = new Set()

const DORMANT_COMPRESS_CONTEXT_CHANNEL_RELS = [
  'src/main/modules/agent-control/contracts/run-contracts.ts',
]

function relposix(abs, root = ROOT) {
  return path.relative(root, abs).split(path.sep).join('/')
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

function importedSpecifiers(source) {
  const specs = []
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(source))) specs.push(match[1])
  }
  return specs
}

function isDormantCompactionBarrelImport(spec) {
  const normalized = String(spec || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === './compaction'
    || normalized === '../compaction'
    || normalized.endsWith('/compaction')
    || normalized.endsWith('/compaction/index')
}

function check({ root = ROOT } = {}) {
  const errors = []
  const sdkPath = path.join(root, SDK_RUNTIME_REL)
  if (!fs.existsSync(sdkPath)) {
    errors.push(`missing_sdk_runtime:${SDK_RUNTIME_REL}`)
  } else {
    const sdkSource = fs.readFileSync(sdkPath, 'utf8')
    const sdkImports = importedSpecifiers(sdkSource)
    for (const forbidden of SDK_FORBIDDEN_IMPORTS) {
      if (sdkImports.some((spec) => spec.includes(forbidden))) {
        errors.push(`sdk_runtime_imports_dormant_compaction:${forbidden}`)
      }
    }
  }

  for (const rel of DORMANT_COMPRESS_CONTEXT_CHANNEL_RELS) {
    const filePath = path.join(root, rel)
    if (!fs.existsSync(filePath)) {
      errors.push(`missing_dormant_compress_context_channel_file:${rel}`)
      continue
    }
    const source = fs.readFileSync(filePath, 'utf8')
    if (/\bcompressContext\b/.test(source)) {
      errors.push(`unexpected_dormant_compress_context_channel:${rel}`)
    }
  }

  const mainRoot = path.join(root, MAIN_ROOT_REL)
  if (fs.existsSync(mainRoot)) {
    for (const file of listTsFiles(mainRoot)) {
      const rel = relposix(file, root)
      if (rel.includes('/__tests__/')) continue
      const imports = importedSpecifiers(fs.readFileSync(file, 'utf8'))
      if (imports.some((spec) => spec.includes('context-compression')) && !CONTEXT_COMPRESSION_ALLOWED.has(rel)) {
        errors.push(`unexpected_context_compression_import:${rel}`)
      }
      if (imports.some((spec) => isDormantCompactionBarrelImport(spec))) {
        errors.push(`unexpected_dormant_compaction_barrel_import:${rel}`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-dormant-compaction-not-in-live-path] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-dormant-compaction-not-in-live-path] OK')
}

module.exports = { check }
