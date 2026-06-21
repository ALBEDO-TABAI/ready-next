#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const CAPABILITY_TYPES_REL = 'src/main/modules/browser-engine/capability-types.ts'
const TASK_EVENT_BRIDGE_REL = 'src/main/modules/browser-engine/task-event-bridge.ts'
const ROUTE_CONST_NAME = 'BROWSER_CAPABILITY_TASK_KINDS'

const EXPECTED_ROUTES = [
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
  'card_loop',
]

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function extractRouteConst(text) {
  const match = text.match(new RegExp(`export\\s+const\\s+${ROUTE_CONST_NAME}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`))
  if (!match) return null
  return [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((route) => route[1])
}

function compareRoutes(actual) {
  const errors = []
  const duplicateRoutes = actual.filter((route, index) => actual.indexOf(route) !== index)
  const missingRoutes = EXPECTED_ROUTES.filter((route) => !actual.includes(route))
  const extraRoutes = actual.filter((route) => !EXPECTED_ROUTES.includes(route))

  if (duplicateRoutes.length > 0) errors.push(`route_const_duplicate:${[...new Set(duplicateRoutes)].join(',')}`)
  if (missingRoutes.length > 0) errors.push(`route_const_missing:${missingRoutes.join(',')}`)
  if (extraRoutes.length > 0) errors.push(`route_const_extra:${extraRoutes.join(',')}`)
  return errors
}

function hasCopiedRouteArray(text) {
  if (/\bDEFAULT_TASK_ROUTES\b/.test(text)) return true
  const arrayMatches = text.match(/\[[\s\S]*?\]/g) || []
  return arrayMatches.some((arrayText) => {
    const copiedCount = EXPECTED_ROUTES.filter((route) => {
      const routePattern = new RegExp(`['"]${route}['"]`)
      return routePattern.test(arrayText)
    }).length
    return copiedCount >= 2
  })
}

function check({ root = ROOT } = {}) {
  const errors = []
  let capabilityText = ''
  let bridgeText = ''

  try {
    capabilityText = stripComments(read(root, CAPABILITY_TYPES_REL))
  } catch (error) {
    errors.push(`missing_capability_types:${CAPABILITY_TYPES_REL}:${error.message}`)
  }

  try {
    bridgeText = stripComments(read(root, TASK_EVENT_BRIDGE_REL))
  } catch (error) {
    errors.push(`missing_task_event_bridge:${TASK_EVENT_BRIDGE_REL}:${error.message}`)
  }

  if (capabilityText) {
    const routes = extractRouteConst(capabilityText)
    if (!routes) {
      errors.push(`missing_route_const:${CAPABILITY_TYPES_REL}:${ROUTE_CONST_NAME}`)
    } else {
      errors.push(...compareRoutes(routes))
    }

    const derivedTypePattern = new RegExp(
      `export\\s+type\\s+BrowserCapabilityTaskKind\\s*=\\s*typeof\\s+${ROUTE_CONST_NAME}\\s*\\[\\s*number\\s*\\]`,
    )
    if (!derivedTypePattern.test(capabilityText)) {
      errors.push(`task_kind_type_not_derived:${CAPABILITY_TYPES_REL}`)
    }
  }

  if (bridgeText) {
    const importPattern = new RegExp(
      `import\\s+\\{[\\s\\S]*\\b${ROUTE_CONST_NAME}\\b[\\s\\S]*\\}\\s+from\\s+['"]\\.\\/capability-types['"]`,
    )
    if (!importPattern.test(bridgeText)) {
      errors.push(`bridge_missing_route_const_import:${TASK_EVENT_BRIDGE_REL}`)
    }

    const setPattern = new RegExp(`new\\s+Set(?:\\s*<[^>]+>)?\\s*\\(\\s*${ROUTE_CONST_NAME}\\s*\\)`)
    if (!setPattern.test(bridgeText)) {
      errors.push(`bridge_not_initialized_from_route_const:${TASK_EVENT_BRIDGE_REL}`)
    }

    if (hasCopiedRouteArray(bridgeText)) {
      errors.push(`bridge_has_copied_route_list:${TASK_EVENT_BRIDGE_REL}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-task-route-single-source] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-task-route-single-source] OK')
}

module.exports = { check }
