#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const TARGET = 'src/main/modules/skills-runtime/runtime-manager.ts'

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function findMethodBody(source, methodName) {
  const match = new RegExp(`${methodName}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\{`, 'm').exec(source)
  if (!match) return null
  const openIndex = source.indexOf('{', match.index)
  const closeIndex = findMatchingBrace(source, openIndex)
  if (closeIndex < 0) return null
  return source.slice(openIndex + 1, closeIndex)
}

function findMatchingBrace(source, openIndex) {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function validateScheduleOutcomeSource(source) {
  const stripped = stripComments(source)
  const errors = []
  const createBody = findMethodBody(stripped, 'createSchedule')
  const runBody = findMethodBody(stripped, 'runScheduledTask')

  if (!createBody) {
    errors.push('createSchedule method not found')
  } else {
    if (!/actions\s*\.\s*(some|find)\s*\(/.test(createBody) || !/request\.action/.test(createBody)) {
      errors.push('createSchedule must validate request.action against the selected skill actions before INSERT')
    }
  }

  if (!runBody) {
    errors.push('runScheduledTask method not found')
  } else {
    if (!/const\s+\w+\s*=\s*await\s+this\.runSkill\s*\(/.test(runBody)) {
      errors.push('runScheduledTask must store the runSkill result')
    }
    if (!/if\s*\(\s*!\s*\w+\.success\s*\)/.test(runBody)) {
      errors.push('runScheduledTask must branch on !result.success')
    }
    const runSkillIndex = runBody.indexOf('this.runSkill')
    const successIndex = runBody.search(/!\s*\w+\.success/)
    const normalAdvanceIndex = runBody.indexOf('interval_minutes')
    if (runSkillIndex >= 0 && normalAdvanceIndex >= 0 && (successIndex < 0 || successIndex > normalAdvanceIndex)) {
      errors.push('runScheduledTask must check success before normal interval advance')
    }
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const source = fs.readFileSync(path.join(process.cwd(), TARGET), 'utf8')
  const result = validateScheduleOutcomeSource(source)
  if (!result.ok) {
    console.error('[check-schedule-tick-outcome-funnel] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-schedule-tick-outcome-funnel] OK')
}

if (require.main === module) {
  main()
}

module.exports = { findMethodBody, validateScheduleOutcomeSource }
