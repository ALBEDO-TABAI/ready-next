#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MODEL_VISIBLE_FILES = [
  {
    file: 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts',
    required: ['model-visible-tool-output', 'buildModelVisibleToolResultPayload', 'redactModelVisibleToolText'],
  },
  {
    file: 'src/main/modules/agent-control/runtime-core/turn-transcript.ts',
    required: ['model-visible-tool-output', 'serializeToolExecutionOutputForModel'],
  },
  {
    file: 'src/main/modules/agent-control/domain-adapters/document-domain-orchestrator.ts',
    required: ['model-visible-tool-output'],
  },
  {
    file: 'src/main/modules/claude-bridge/tool-bridge.ts',
    required: ['model-visible-tool-output', 'serializeToolExecutionOutputForModel'],
  },
  {
    file: 'src/main/modules/claude-bridge/openai-history-sanitization.ts',
    required: ['model-visible-tool-output', 'redactModelVisibleToolText'],
  },
  {
    file: 'src/main/modules/agent-control/skills/skill-context-orchestrator.ts',
    required: ['model-visible-tool-output', 'redactModelVisibleToolText'],
    forbidRawFallback: true,
  },
]

const RAW_SERIALIZER_FORBIDDEN_FILES = [
  ...MODEL_VISIBLE_FILES.map((item) => item.file),
  'src/main/modules/claude-bridge/direct-chat.ts',
]

function relposix(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function read(root, rel, errors) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    errors.push(`missing_file:${rel}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

function stripForModelNames(source) {
  return source.replace(/\bserializeToolExecutionOutputForModel\b/g, '')
}

function check(options = {}) {
  const root = options.root || process.cwd()
  const errors = []

  for (const entry of MODEL_VISIBLE_FILES) {
    const source = read(root, entry.file, errors)
    if (!source) continue
    for (const token of entry.required) {
      if (!source.includes(token)) {
        errors.push(`missing_model_visible_funnel:${entry.file}:${token}`)
      }
    }
    if (entry.forbidRawFallback) {
      if (/emitOutput\(\s*result\.text/.test(source)) {
        errors.push(`raw_reference_skill_emit:${entry.file}`)
      }
      if (/extractSkillReferenceContent\(\s*result\.text\)/.test(source)) {
        errors.push(`raw_reference_skill_injection:${entry.file}`)
      }
    }
  }

  for (const rel of RAW_SERIALIZER_FORBIDDEN_FILES) {
    const source = read(root, rel, errors)
    if (!source) continue
    const withoutForModel = stripForModelNames(source)
    if (/\bserializeToolExecutionOutput\b/.test(withoutForModel)) {
      errors.push(`raw_tool_output_serializer_in_model_visible_file:${rel}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = check()
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[check-model-visible-tool-output-funnel] FAIL ${error}`)
    }
    process.exit(1)
  }
  console.log('[check-model-visible-tool-output-funnel] OK')
}

if (require.main === module) {
  main()
}

module.exports = {
  MODEL_VISIBLE_FILES,
  RAW_SERIALIZER_FORBIDDEN_FILES,
  check,
  relposix,
}
