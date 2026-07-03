#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8')
  const runner = stripComments(readAt('src/main/modules/tools/browser-agent-runner.ts'))
  const binding = stripComments(readAt('src/main/modules/browser-engine/browser-surface-binding.ts'))
  const supervision = stripComments(readAt('src/main/modules/browser-engine/ipc-supervision.ts'))
  const hostLayout = stripComments(readAt('src/main/modules/browser-engine/host-layout-service.ts'))
  const controller = stripComments(readAt('src/main/modules/browser-engine/ipc-handler.ts'))
  const authPopup = stripComments(readAt('src/main/modules/browser-engine/auth-popup-manager.ts'))
  const workflowSession = stripComments(readAt('src/main/modules/browser-engine/browser-workflow-session.ts'))

  if (!runner.includes('beginForegroundBrowserWorkflowSession')) {
    errors.push('runner_missing_foreground_workflow_session')
  }
  if (!runner.includes('prepareToolArgs') || !runner.includes('tab_id: this.boundTabId')) {
    errors.push('runner_missing_bound_tab_arg_inheritance')
  }
  if (runner.includes("this.boundSurface === 'user-view') return args")) {
    errors.push('runner_user_view_bound_workflow_can_fall_back_to_active_tab')
  }
  if (!runner.includes('getWorkflowTabRecord') || !runner.includes('bound tab unavailable')) {
    errors.push('runner_missing_closed_bound_tab_guard')
  }
  if (!runner.includes('runUnderBrowserViewLease')) {
    errors.push('runner_missing_lane_aware_lease')
  }
  if (runner.includes('runUnderUserViewLease')) {
    errors.push('runner_still_uses_fixed_user_view_lease')
  }
  if (/updateTabRuntimeState\(\s*activeTabId\s*,\s*\{[\s\S]{0,120}owner:\s*'agent'/.test(runner)) {
    errors.push('runner_marks_active_tab_as_agent')
  }
  if (!binding.includes('agent-view-foreground') || !binding.includes('boundSurface')) {
    errors.push('surface_binding_not_lane_aware_for_runner')
  }
  if (!supervision.includes('foregroundWorkflowTask') || !supervision.includes('foregroundAgentTabId ||')) {
    errors.push('supervision_missing_foreground_workflow_priority')
  }
  if (!controller.includes('foregroundAgentTabId') || !controller.includes('adoptForegroundWorkflowPopup')) {
    errors.push('controller_missing_foreground_agent_slot_or_popup_follow')
  }
  if (!controller.includes('getForegroundAgentLaneStartBlocker')) {
    errors.push('controller_missing_agent_lane_start_preflight')
  }
  if (!controller.includes('closeForegroundBrowserWorkflowSession') || !workflowSession.includes("BrowserWorkflowSessionStatus = 'running' | 'closed'")) {
    errors.push('workflow_session_looks_like_run_terminal_channel')
  }
  if (!controller.includes('syncPopupContextForTab') || !authPopup.includes('PopupOpenInTabContext')) {
    errors.push('popup_lane_context_not_preserved')
  }
  if (!authPopup.includes('this.openInTab(pending.url, pending.context)')) {
    errors.push('auth_popup_fallback_drops_lane_context')
  }
  if (!hostLayout.includes('backgroundThrottling: false')) {
    errors.push('browser_hosts_missing_background_throttling_false')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-agent-lane-bound-target] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-agent-lane-bound-target] OK')
}

module.exports = { check }
