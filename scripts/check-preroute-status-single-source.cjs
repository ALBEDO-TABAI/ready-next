#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const failures = []
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

for (const rel of [
  'src/main/modules/agent-control/agents/session-preroute.ts',
  'src/main/modules/agent-control/agents/session-preroute-trace.ts',
  'src/main/modules/agent-control/runtime-core/session-preroute-service.ts',
  'src/main/modules/claude-bridge/ipc/session-preroute-group.ts',
  'src/main/modules/settings-engine/agent-session-preroute-setting.ts',
]) {
  if (exists(rel)) failures.push(`retired preroute module still exists: ${rel}`)
}

const sources = {
  runtime: read('src/main/modules/agent-control/runtime-core/runtime.ts'),
  ipc: read('src/main/modules/claude-bridge/ipc-handler.ts'),
  preload: read('src/preload/index.ts'),
  settings: read('src/main/modules/settings-engine/ipc-handler.ts'),
  hub: read('src/renderer/components/agent-system/AgentSettingsHub.tsx'),
  studio: read('src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx'),
  selector: read('src/renderer/stores/useAgent.ts'),
  genericSettings: read('src/main/modules/settings-engine/generic-setting-ipc-handler.ts'),
}

const forbidden = /evaluateSessionPreroute|simulateSystemStudioRouting|getAgentSessionPrerouteMode|setAgentSessionPrerouteMode|SessionPrerouteService|sessionPrerouteService/
for (const [label, source] of Object.entries(sources)) {
  if (forbidden.test(source)) failures.push(`${label} still exposes retired preroute control`)
}
if (/agentPersonality|mapPersonalitiesToAgents/.test(sources.selector)) {
  failures.push('historical personalities still populate the live Agent selector')
}
if (/新会话智能路由|路由试算|自动路由/.test(`${sources.hub}\n${sources.studio}`)) {
  failures.push('Settings still advertises preroute behavior')
}
for (const key of ['agent.sessionPrerouteMode', 'agent.knowledgeSystemEnabled']) {
  if (!sources.genericSettings.includes(`'${key}'`)) failures.push(`generic settings backdoor is not blocked for ${key}`)
}
if (!sources.genericSettings.includes('retired_agent_control_setting')) {
  failures.push('generic settings backdoor lacks a retired-control error')
}

if (failures.length > 0) {
  console.error(`[check-preroute-status-single-source] FAIL\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('[check-preroute-status-single-source] OK: preroute and fake persona/knowledge controls are retired')
