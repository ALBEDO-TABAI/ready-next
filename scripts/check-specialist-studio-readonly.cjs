#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const failures = []
const fail = (message) => failures.push(message)
const read = (rel) => {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    fail(`missing required file: ${rel}`)
    return ''
  }
  return fs.readFileSync(abs, 'utf8')
}

const ipc = read('src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts')
for (const channel of [
  'agent:systemStudio:getSnapshot',
  'agent:systemStudio:stageContentEdit',
  'agent:systemStudio:confirmContentEdit',
  'agent:systemStudio:rejectContentEdit',
]) {
  if (!ipc.includes(channel)) fail(`Studio IPC is missing preserved file-proposal channel: ${channel}`)
}
for (const retired of [
  'agent:systemStudio:simulateRouting',
  'agent:systemStudio:create',
  'agent:systemStudio:transition',
  'confirmSpecialistBlueprint',
  'confirmDerivation',
  'updateRegistryStatus',
]) {
  if (ipc.includes(retired)) fail(`Studio IPC still exposes retired control: ${retired}`)
}

const preload = read('src/preload/index.ts')
for (const required of [
  'getSystemStudioSnapshot',
  'stageSystemStudioContentEdit',
  'confirmSystemStudioContentEdit',
  'rejectSystemStudioContentEdit',
]) {
  if (!preload.includes(required)) fail(`preload is missing preserved archive/file method: ${required}`)
}
for (const retired of [
  'simulateSystemStudioRouting',
  'confirmSpecialistBlueprint',
  'renameSpecialistAgent',
  'confirmDerivation',
  'rejectDerivation',
  'updateRegistryStatus',
  'deleteRegistryAgent',
]) {
  if (preload.includes(retired)) fail(`preload still exposes retired Agent control: ${retired}`)
}

const component = read('src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx')
if (!component.includes('getSystemStudioSnapshot')) fail('Studio must load the historical snapshot')
for (const required of ['confirmSystemStudioContentEdit', 'rejectSystemStudioContentEdit']) {
  if (!component.includes(required)) fail(`Studio must preserve explicit file-proposal action: ${required}`)
}
for (const retired of [
  'simulateSystemStudioRouting',
  'confirmSpecialistBlueprint',
  'renameSpecialistAgent',
  'confirmDerivation',
  'updateRegistryStatus',
  'adopt_candidate',
]) {
  if (component.includes(retired)) fail(`Studio component still exposes retired Agent control: ${retired}`)
}
if (!component.includes('不会改变当前 Codex')) fail('Studio must state that historical records do not change Codex')
if (!component.includes('不会自动创建或分配 Agent')) fail('Studio must state that records do not create or assign Agent')

const hub = read('src/renderer/components/agent-system/AgentSettingsHub.tsx')
if (!hub.includes('<PersonalityEditor />')) fail('Agent Settings must preserve personality archive CRUD')
if (!hub.includes('<AgentSystemStudio />')) fail('Agent Settings must preserve historical specialist audit')
if (!hub.includes('不会改变当前 Codex')) fail('Agent Settings must describe archive behavior honestly')

const settings = read('src/renderer/pages/Settings.tsx')
if (!settings.includes('<AgentSettingsHub />')) fail('Settings must render the historical Agent archive hub')

if (failures.length > 0) {
  console.error(`[check-specialist-studio-readonly] FAIL: ${failures.join('\n')}`)
  process.exit(1)
}
console.log('[check-specialist-studio-readonly] OK')
