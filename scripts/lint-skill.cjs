#!/usr/bin/env node
'use strict'
/**
 * P3-3 — agentskills.io-spec lint CLI for a skill directory.
 *   node scripts/lint-skill.cjs <skill-dir>
 * Prints ERROR / WARN lines; exit 1 if any ERROR, 0 otherwise (2 on usage error).
 * Rules live in the shared lint-skill-core.cjs (same engine the import pipeline uses).
 */
const fs = require('node:fs')
const path = require('node:path')

const { lintSkillInputs } = require('./lint-skill-core.cjs')

function readSkillDirInputs(dir) {
  const dirName = path.basename(path.resolve(dir))
  let json = null
  const jsonPath = path.join(dir, 'ready-skill.json')
  if (fs.existsSync(jsonPath)) {
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    } catch (e) {
      json = { __parseError: e.message }
    }
  }
  let skillMd = null
  const mdPath = path.join(dir, 'SKILL.md')
  if (fs.existsSync(mdPath)) {
    try {
      skillMd = fs.readFileSync(mdPath, 'utf8')
    } catch {
      // unreadable SKILL.md → treated as absent
    }
  }
  let hasScripts = false
  try {
    hasScripts = fs.statSync(path.join(dir, 'scripts')).isDirectory()
  } catch {
    // no scripts/
  }
  return { dirName, json, skillMd, hasScripts }
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/lint-skill.cjs <skill-dir>')
    process.exit(2)
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    console.error(`[lint-skill] not a directory: ${target}`)
    process.exit(2)
  }
  const inputs = readSkillDirInputs(target)
  if (inputs.json && inputs.json.__parseError) {
    console.error(`ERROR ready-skill.json 无法解析：${inputs.json.__parseError}`)
    inputs.json = null
  }
  const { errors, warnings } = lintSkillInputs(inputs)
  for (const e of errors) console.error(`ERROR ${e}`)
  for (const w of warnings) console.log(`WARN  ${w}`)
  if (errors.length === 0) {
    console.log(`[lint-skill] OK${warnings.length ? ` (${warnings.length} warning)` : ''}: ${target}`)
    process.exit(0)
  }
  console.error(`[lint-skill] FAIL: ${errors.length} error(s) in ${target}`)
  process.exit(1)
}

main()
