#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MODEL_VISIBLE_OUTPUT_FILE = 'src/main/modules/agent-control/tools-runtime/model-visible-tool-output.ts'
const HOST_PATH_REDACTOR_FILE = 'src/main/modules/tools/skill-primitives/host-path-redactor.ts'

function read(root, rel, errors) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) {
    errors.push(`missing_file:${rel}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}`)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

function check(options = {}) {
  const root = options.root || process.cwd()
  const errors = []
  const modelVisible = read(root, MODEL_VISIBLE_OUTPUT_FILE, errors)
  const redactor = read(root, HOST_PATH_REDACTOR_FILE, errors)

  if (modelVisible) {
    const payloadBody = extractFunctionBody(modelVisible, 'buildModelVisibleToolResultPayload')
    if (!payloadBody) {
      errors.push(`missing_function:${MODEL_VISIBLE_OUTPUT_FILE}:buildModelVisibleToolResultPayload`)
    } else {
      const requiredRedactedFields = [
        ['data', /data:\s*redactModelVisibleValue\(normalized\.data\)/],
        ['projectionPatch', /projectionPatch:\s*redactModelVisibleValue\(normalized\.projectionPatch\)/],
        ['framePatch', /framePatch:\s*redactModelVisibleValue\(normalized\.framePatch\)/],
      ]
      for (const [field, pattern] of requiredRedactedFields) {
        if (!pattern.test(payloadBody)) {
          errors.push(`missing_model_visible_redaction_field:${field}`)
        }
      }
      if (/\bcontextModifier\s*:/.test(payloadBody)) {
        errors.push('model_visible_internal_context_modifier')
      }
      if (/\benvelope\s*:/.test(payloadBody)) {
        errors.push('model_visible_internal_envelope')
      }
    }
  }

  if (redactor) {
    if (!/\brealpathSync\.native\(/.test(redactor)) {
      errors.push('missing_canonical_static_root_redaction')
    }
    if (!/redactStaticRoot\(out,\s*tmpdir\(\),\s*'<tmp>'\)/.test(redactor)) {
      errors.push('missing_tmp_static_root_redaction')
    }
    if (!/redactStaticRoot\(out,\s*currentResourcesPath\(\),\s*'<app>'\)/.test(redactor)) {
      errors.push('missing_resources_static_root_redaction')
    }
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = check()
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`[check-model-visible-primitive-path-redaction] FAIL ${error}`)
    }
    process.exit(1)
  }
  console.log('[check-model-visible-primitive-path-redaction] OK')
}

if (require.main === module) {
  main()
}

module.exports = {
  HOST_PATH_REDACTOR_FILE,
  MODEL_VISIBLE_OUTPUT_FILE,
  check,
  extractFunctionBody,
}
