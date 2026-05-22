#!/usr/bin/env node
/**
 * Lock the `ask_user_questions` tool name in 4 places so a singular/plural
 * drift can't silently break dispatch:
 *   1. `tool-defs` declares `AGENT_INTERACTION_TOOL_NAMES = ['ask_user_questions']`
 *   2. `agent-interaction-schemas` exports a key for it.
 *   3. `tool-parallelism-policy` has an explicit branch for the name.
 *   4. `tool-executor` dispatches the agent_interaction domain (which routes
 *      this tool).
 *
 * Mirrors check-mcp-group-registered's strategy of grep-ping known anchor
 * lines so a typo in one file is caught by the gate instead of by a runtime
 * `Unknown tool: ...` surfacing in the chat.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const FROZEN_NAME = 'ask_user_questions'
const TOOL_DEFS_FILE = 'src/main/modules/tools/agent-interaction-tool-defs.ts'
const SCHEMAS_FILE = 'src/main/modules/tools/schemas/agent-interaction-schemas.ts'
const PARALLELISM_FILE = 'src/main/modules/agent-control/tools-runtime/tool-parallelism-policy.ts'
const EXECUTOR_FILE = 'src/main/modules/tools/tool-executor.ts'
const HANDLER_FILE = 'src/main/modules/tools/builtins/ask-user-questions.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const toolDefs = read(TOOL_DEFS_FILE)
  if (!toolDefs) {
    violations.push({ file: TOOL_DEFS_FILE, reason: 'missing file' })
  } else {
    if (!new RegExp(`AGENT_INTERACTION_TOOL_NAMES[\\s\\S]*?['"]${FROZEN_NAME}['"]`).test(toolDefs)) {
      violations.push({
        file: TOOL_DEFS_FILE,
        reason: `AGENT_INTERACTION_TOOL_NAMES must list the frozen name '${FROZEN_NAME}'`,
      })
    }
  }

  const schemas = read(SCHEMAS_FILE)
  if (!schemas) {
    violations.push({ file: SCHEMAS_FILE, reason: 'missing file' })
  } else {
    if (!new RegExp(`${FROZEN_NAME}\\s*:`).test(schemas)) {
      violations.push({
        file: SCHEMAS_FILE,
        reason: `AGENT_INTERACTION_SCHEMAS must include key '${FROZEN_NAME}'`,
      })
    }
  }

  const parallelism = read(PARALLELISM_FILE)
  if (!parallelism) {
    violations.push({ file: PARALLELISM_FILE, reason: 'missing file' })
  } else {
    if (!new RegExp(`normalized\\s*===\\s*['"]${FROZEN_NAME}['"]`).test(parallelism)) {
      violations.push({
        file: PARALLELISM_FILE,
        reason: `getToolResourceTag must dispatch the literal '${FROZEN_NAME}'`,
      })
    }
  }

  const executor = read(EXECUTOR_FILE)
  if (!executor) {
    violations.push({ file: EXECUTOR_FILE, reason: 'missing file' })
  } else if (!/case\s+['"]agent_interaction['"]\s*:/.test(executor)) {
    violations.push({
      file: EXECUTOR_FILE,
      reason: "tool-executor switch must include `case 'agent_interaction':`",
    })
  } else if (!/executeAskUserQuestions\s*\(/.test(executor)) {
    violations.push({
      file: EXECUTOR_FILE,
      reason: 'tool-executor must call `executeAskUserQuestions(...)` from the agent_interaction case',
    })
  }

  const handler = read(HANDLER_FILE)
  if (!handler) {
    violations.push({ file: HANDLER_FILE, reason: 'missing file' })
  }

  if (violations.length === 0) {
    console.log('[check-ask-user-questions-tool-name-frozen] OK')
    process.exit(0)
  }
  console.error('[check-ask-user-questions-tool-name-frozen] FAIL:')
  for (const v of violations) {
    console.error(`  - ${v.file}: ${v.reason}`)
  }
  process.exit(1)
}

main()
