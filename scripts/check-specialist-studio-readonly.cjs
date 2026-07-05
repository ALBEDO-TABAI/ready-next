#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

function fail(message) {
  console.error(`[check-specialist-studio-readonly] FAIL: ${message}`)
  process.exit(1)
}

const ipc = read('src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts')
if (!ipc.includes("'agent:systemStudio:getSnapshot'")) {
  fail('Studio IPC must expose the read-only snapshot channel')
}
if (!ipc.includes("'agent:systemStudio:simulateRouting'")) {
  fail('Studio IPC must expose the read-only routing simulation channel')
}
for (const required of [
  'agent:systemStudio:stageContentEdit',
  'agent:systemStudio:confirmContentEdit',
  'agent:systemStudio:rejectContentEdit',
]) {
  if (!ipc.includes(`'${required}'`)) fail(`Studio IPC must expose the content proposal channel: ${required}`)
}
for (const forbidden of [
  'agent:systemStudio:create',
  'agent:systemStudio:transition',
  'agent:systemStudio:updateStatus',
  'agent:systemStudio:merge',
  'agent:systemStudio:retire',
  'agent:derivation:confirm',
  'agent:beliefCards:transition',
  'updateStatus(',
  '.create(',
]) {
  if (ipc.includes(forbidden)) fail(`Studio IPC contains a forbidden write token: ${forbidden}`)
}

const preload = read('src/preload/index.ts')
if (!preload.includes('getSystemStudioSnapshot')) {
  fail('preload must expose getSystemStudioSnapshot')
}
if (!preload.includes("ipcRenderer.invoke('agent:systemStudio:getSnapshot')")) {
  fail('preload Studio method must call the snapshot channel')
}
if (!preload.includes('simulateSystemStudioRouting')) {
  fail('preload must expose simulateSystemStudioRouting')
}
if (!preload.includes("ipcRenderer.invoke('agent:systemStudio:simulateRouting'")) {
  fail('preload Studio method must call the routing simulation channel')
}
for (const required of [
  'stageSystemStudioContentEdit',
  'confirmSystemStudioContentEdit',
  'rejectSystemStudioContentEdit',
]) {
  if (!preload.includes(required)) fail(`preload must expose ${required}`)
}

const component = [
  read('src/renderer/components/agent-system/AgentSystemStudio.tsx'),
  read('src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx'),
].join('\n')
for (const forbidden of [
  'confirmDerivation',
  'rejectDerivation',
  'updateRegistryStatus',
  'transitionCard',
  'setKnowledgeSystemEnabled',
  'agent:systemStudio:create',
  'agent:systemStudio:transition',
]) {
  if (component.includes(forbidden)) fail(`Studio component contains a forbidden write token: ${forbidden}`)
}
if (!component.includes('getSystemStudioSnapshot')) {
  fail('Studio component must load through the read-only snapshot method')
}
if (!component.includes('simulateSystemStudioRouting')) {
  fail('Studio component must use the read-only routing simulation method')
}
for (const required of [
  'stageSystemStudioContentEdit',
  'confirmSystemStudioContentEdit',
  'rejectSystemStudioContentEdit',
]) {
  if (!component.includes(required)) fail(`Studio component must use ${required}`)
}

const settings = read('src/renderer/pages/Settings.tsx')
const hub = read('src/renderer/components/agent-system/AgentSettingsHub.tsx')
if (!settings.includes('<AgentSettingsHub />')) {
  fail('Settings must render the agent settings hub')
}
if (!hub.includes('<AgentSystemStudio />')) {
  fail('AgentSettingsHub must render AgentSystemStudio')
}

console.log('[check-specialist-studio-readonly] OK')
