#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const ENGINE_REL = 'src/main/modules/browser-engine'
const GOVERNOR_REL = `${ENGINE_REL}/browser-tab-load-governor.ts`
const CONTROLLER_REL = `${ENGINE_REL}/ipc-handler.ts`
const CONTROLLER_COMPOSITION_REL = `${ENGINE_REL}/browser-controller-composition.ts`
const CONTROLLER_TAB_REL = `${ENGINE_REL}/browser-controller-tab-runtime.ts`
const CONTROLLER_CAPTURE_REL = `${ENGINE_REL}/browser-controller-capture-runtime.ts`
const PERFORMANCE_RUNTIME_REL = `${ENGINE_REL}/browser-performance-runtime.ts`
const TAB_LIFECYCLE_REL = `${ENGINE_REL}/tab-lifecycle-service.ts`
const MAIN_INDEX_REL = 'src/main/index.ts'
const SYNC_MODE_FILES = [
  'src/shared/browser-view-intent.ts',
  'src/shared/browser-view-layout.ts',
  `${ENGINE_REL}/host-types.ts`,
  `${ENGINE_REL}/host-layout-service.ts`,
  `${ENGINE_REL}/tab-shell-service.ts`,
]

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function listTypeScriptFiles(root, rel) {
  const base = path.join(root, rel)
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(rel, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(root, child)
    return /\.tsx?$/.test(entry.name) ? [child] : []
  })
}

function read(root, rel) {
  return stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))
}

function hasDisallowedForcedFullSpeed(rel, source) {
  const matches = [...source.matchAll(/backgroundThrottling\s*:\s*false/g)]
  if (matches.length === 0) return false
  if (rel !== CONTROLLER_CAPTURE_REL) return true
  const captureStart = source.indexOf('async captureBackgroundPage(')
  return matches.some((match) => {
    const offset = match.index ?? -1
    if (captureStart < 0 || offset < captureStart || offset - captureStart > 4_000) return true
    return !source.slice(captureStart, offset).includes('const probeWindow = new BrowserWindow(')
  })
}

function check({ root = ROOT } = {}) {
  const errors = []
  let engineFiles = []
  try {
    engineFiles = listTypeScriptFiles(root, ENGINE_REL)
  } catch (error) {
    return { ok: false, errors: [`missing_browser_engine:${error.message}`] }
  }

  for (const rel of engineFiles) {
    const source = read(root, rel)
    if (hasDisallowedForcedFullSpeed(rel, source)) {
      errors.push(`background_throttling_forced_off:${rel}`)
    }
    if (rel !== GOVERNOR_REL && /\.setBackgroundThrottling\s*\(/.test(source)) {
      errors.push(`background_throttling_outside_governor:${rel}`)
    }
    if (rel !== CONTROLLER_COMPOSITION_REL && /browser:tabUpdate/.test(source)) {
      errors.push(`tab_update_bypasses_controller_batcher:${rel}`)
    }
  }

  try {
    const controller = read(root, CONTROLLER_TAB_REL)
    const lifecycle = read(root, TAB_LIFECYCLE_REL)
    if (
      !/registerDormantTabs\s*\([^)]*\)[\s\S]*tabLifecycleService\.registerDormantTabs\s*\(/.test(controller)
      || !/registerDormantTabs\s*\(/.test(lifecycle)
      || !/this\.materializeTab\s*\(/.test(lifecycle)
    ) {
      errors.push(`missing_dormant_materialization_contract:${CONTROLLER_TAB_REL}`)
    }
    const runtime = read(root, PERFORMANCE_RUNTIME_REL)
    if (
      !/new BrowserPerformanceRuntime\s*\([\s\S]*emitTabUpdate:[\s\S]*sendToRendererImmediate\('browser:tabUpdate'/.test(read(root, CONTROLLER_COMPOSITION_REL))
      || !/new BrowserTabUpdateBatcher\s*\([\s\S]*emit:[\s\S]*deps\.emitTabUpdate/.test(runtime)
    ) {
      errors.push(`missing_tab_update_batcher_boundary:${CONTROLLER_COMPOSITION_REL}`)
    }
  } catch (error) {
    errors.push(`missing_controller:${error.message}`)
  }

  try {
    if (/rsshubManager\.start\s*\(/.test(read(root, MAIN_INDEX_REL))) {
      errors.push(`rsshub_eager_start:${MAIN_INDEX_REL}`)
    }
  } catch (error) {
    errors.push(`missing_main_index:${error.message}`)
  }

  for (const rel of SYNC_MODE_FILES) {
    try {
      if (/\bsyncMode\b/.test(read(root, rel))) errors.push(`legacy_sync_mode:${rel}`)
    } catch (error) {
      errors.push(`missing_contract_file:${rel}:${error.message}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-performance-contract] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-performance-contract] OK')
}

module.exports = { check }
