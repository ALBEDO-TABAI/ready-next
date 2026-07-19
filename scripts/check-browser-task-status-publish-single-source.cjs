#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const CAPABILITY_TYPES_REL = 'src/main/modules/browser-engine/capability-types.ts'
const TASK_EVENT_BRIDGE_REL = 'src/main/modules/browser-engine/task-event-bridge.ts'
const TASK_PERSISTENCE_REL = 'src/main/modules/browser-engine/task-persistence-service.ts'
const MAP_NAME = 'BROWSER_TASK_BRIDGE_PUBLISH'
const PERSISTED_TYPE = 'BrowserCapabilityTaskStatus'
const BRIDGE_TYPE = 'TaskEventBridgeStatus'
const NON_PUBLISHERS = ['queued', 'running', 'cancelled']

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function extractTypeUnion(text, typeName) {
  const match = text.match(new RegExp(
    `export\\s+type\\s+${typeName}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*(?:export\\s+)?(?:type|interface|const|class|function)\\b)`,
  ))
  if (!match) return null
  return [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((item) => item[1])
}

function extractPublishMap(text) {
  const match = text.match(new RegExp(`(?:export\\s+)?const\\s+${MAP_NAME}\\s*:[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\}\\s*\\n`))
  if (!match) return null
  const entries = new Map()
  for (const item of match[1].matchAll(/\b([a-z][a-z0-9_]*)\s*:\s*(null|['"]([a-z][a-z0-9_]*)['"])/g)) {
    entries.set(item[1], item[2] === 'null' ? null : item[3])
  }
  return entries
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

function compareMapKeys(statuses, map) {
  const errors = []
  const keys = [...map.keys()]
  for (const status of statuses) {
    if (!map.has(status)) errors.push(`publish_map_missing_status:${status}`)
  }
  for (const key of keys) {
    if (!statuses.includes(key)) errors.push(`publish_map_extra_status:${key}`)
  }
  return errors
}

function publishSitesUseMapping(rel, text, errors) {
  if (!text.includes('taskEventBridge.publish(')) return
  if (!text.includes('toBridgeStatus(')) {
    errors.push(`publish_site_missing_to_bridge_status:${rel}`)
  }
  if (/\bisTaskEventBridgeStatus\s*\(/.test(text)) {
    errors.push(`publish_site_uses_bridge_membership_guard:${rel}`)
  }
}

function check({ root = ROOT } = {}) {
  const errors = []
  let capabilityText = ''
  let bridgeText = ''
  let persistenceText = ''

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
  try {
    persistenceText = stripComments(read(root, TASK_PERSISTENCE_REL))
  } catch (error) {
    errors.push(`missing_task_persistence:${TASK_PERSISTENCE_REL}:${error.message}`)
  }

  const persistedStatuses = capabilityText ? extractTypeUnion(capabilityText, PERSISTED_TYPE) : null
  const bridgeStatuses = bridgeText ? extractTypeUnion(bridgeText, BRIDGE_TYPE) : null
  const publishMap = bridgeText ? extractPublishMap(bridgeText) : null

  if (!persistedStatuses) errors.push(`missing_persisted_status_union:${CAPABILITY_TYPES_REL}:${PERSISTED_TYPE}`)
  if (!bridgeStatuses) errors.push(`missing_bridge_status_union:${TASK_EVENT_BRIDGE_REL}:${BRIDGE_TYPE}`)
  if (!publishMap) errors.push(`missing_publish_map:${TASK_EVENT_BRIDGE_REL}:${MAP_NAME}`)

  if (persistedStatuses) {
    for (const status of duplicates(persistedStatuses)) errors.push(`persisted_status_duplicate:${status}`)
    if (persistedStatuses.includes('needs_attention')) {
      errors.push('needs_attention_leaked_to_persisted')
    }
  }
  if (bridgeStatuses) {
    for (const status of duplicates(bridgeStatuses)) errors.push(`bridge_status_duplicate:${status}`)
    if (!bridgeStatuses.includes('needs_attention')) {
      errors.push('needs_attention_missing_from_bridge')
    }
  }
  if (persistedStatuses && publishMap) {
    errors.push(...compareMapKeys(persistedStatuses, publishMap))
  }
  if (publishMap && bridgeStatuses) {
    for (const [status, mapped] of publishMap.entries()) {
      if (mapped !== null && !bridgeStatuses.includes(mapped)) {
        errors.push(`publish_map_value_not_bridge_status:${status}:${mapped}`)
      }
    }
    for (const status of NON_PUBLISHERS) {
      if (publishMap.get(status) !== null) {
        errors.push(`publish_map_unexpected_publisher:${status}`)
      }
    }
  }
  if (bridgeStatuses) {
    publishSitesUseMapping(TASK_PERSISTENCE_REL, persistenceText, errors)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-task-status-publish-single-source] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-task-status-publish-single-source] OK')
}

module.exports = { check }
