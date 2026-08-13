'use strict'

const { existsSync, readFileSync } = require('node:fs')

function observedEffectCounts(databasePath, sqliteJson) {
  if (!existsSync(databasePath)) {
    return { verified: false, feishuReads: null, larkReads: null }
  }
  try {
    const rows = sqliteJson(databasePath, `
      SELECT admission.tool_name AS toolName, COUNT(*) AS confirmedCount
        FROM codex_tool_call_admissions admission
        JOIN codex_tool_call_bindings binding
          ON binding.ready_run_id = admission.ready_run_id
         AND binding.codex_thread_id = admission.codex_thread_id
         AND binding.codex_turn_id = admission.codex_turn_id
         AND binding.codex_call_id = admission.codex_call_id
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
         AND action.state = 'confirmed'
       WHERE admission.tool_name IN ('feishu_doc_read', 'skill_run_shell')
       GROUP BY admission.tool_name;
    `)
    const count = (toolName) => Number(
      rows.find((row) => row.toolName === toolName)?.confirmedCount || 0,
    )
    return {
      verified: true,
      feishuReads: count('feishu_doc_read'),
      larkReads: count('skill_run_shell'),
    }
  } catch {
    return { verified: false, feishuReads: null, larkReads: null }
  }
}

function safeGatewayCaptureStats(path) {
  if (!existsSync(path)) {
    return { verified: false, validLineCount: null, malformedLineCount: 0 }
  }
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    let malformedLineCount = 0
    let validLineCount = 0
    for (const line of lines) {
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || value.requestKind !== 'product'
          || !['readyRunId', 'threadId', 'turnId'].every(
            (key) => typeof value[key] === 'string' && value[key],
          )
          || typeof value.requestDigest !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.requestDigest)) {
          malformedLineCount += 1
        } else {
          validLineCount += 1
        }
      } catch {
        malformedLineCount += 1
      }
    }
    return {
      verified: malformedLineCount === 0,
      validLineCount: malformedLineCount === 0 ? validLineCount : null,
      malformedLineCount,
    }
  } catch {
    return { verified: false, validLineCount: null, malformedLineCount: null }
  }
}

module.exports = { observedEffectCounts, safeGatewayCaptureStats }
