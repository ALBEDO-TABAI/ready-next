#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const CONTRACT = path.join(ROOT, 'src/shared/skill-host-contract.ts')
const CONTROLLER = path.join(ROOT, 'src/main/modules/skills-runtime/skill-host-controller.ts')
const REQUIRED = ['rm', 'cp', 'mv', 'dd', 'mkfs', 'chmod', 'chown', 'ln']
const SAFE = ['jq', 'rg', 'ffprobe']

function fail(message) {
  console.error(`[check-shell-allowlist-extension] FAIL: ${message}`)
  process.exit(1)
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, file)}: ${error.message}`)
  }
}

const contract = read(CONTRACT)
const controller = read(CONTROLLER)

if (!/DESTRUCTIVE_SHELL_COMMANDS\s*=/.test(contract)) {
  fail('shared destructive shell command list is missing')
}
for (const command of REQUIRED) {
  if (!new RegExp(`['"]${command}['"]`).test(contract)) {
    fail(`destructive list missing ${command}`)
  }
}
for (const command of SAFE) {
  if (new RegExp(`['"]${command}['"]`).test(contract.match(/DESTRUCTIVE_SHELL_COMMANDS[\s\S]*?\] as const/)?.[0] || '')) {
    fail(`safe diagnostic command ${command} must not be destructive`)
  }
}
if (!/shell_allowlist_extensions[\s\S]{0,240}\.superRefine\(/.test(contract)
    && !/shell_allowlist_extensions[\s\S]{0,240}\.refine\(/.test(contract)) {
  fail('shell_allowlist_extensions must reject destructive commands at schema level')
}
if (!/isDestructiveShellCommand/.test(contract)) {
  fail('schema must reference the destructive-command predicate')
}
if (!/isDestructiveShellCommand/.test(controller)) {
  fail('SkillHostController must filter destructive extensions at merge time')
}
if (!/merged\.add\(cmd\)/.test(controller)) {
  fail('SkillHostController merge site not found')
}

console.log('[check-shell-allowlist-extension] OK')
