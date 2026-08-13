#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function fail(message) {
  console.error(`[check-specialist-professional-designer-contract] FAIL: ${message}`)
  process.exit(1)
}

function read(relPath) {
  const full = path.join(ROOT, relPath)
  if (!fs.existsSync(full)) fail(`missing required file: ${relPath}`)
  return fs.readFileSync(full, 'utf8')
}

function assertIncludes(relPath, needles) {
  const source = read(relPath)
  for (const needle of needles) {
    if (!source.includes(needle)) fail(`${relPath} missing required text: ${needle}`)
  }
  return source
}

function assertExcludes(relPath, needles) {
  const source = read(relPath)
  for (const needle of needles) {
    if (source.includes(needle)) fail(`${relPath} contains retired live text: ${needle}`)
  }
}

assertIncludes('src/shared/agent-specialist-blueprint-clarification.ts', [
  "SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION = 'p8g-9b.v1'",
  "'workScope'",
  "'boundaryExamples'",
  "'inputsKnowledgeTools'",
  'buildSpecialistBlueprintProfessionalInterviewContract',
  'compileSpecialistBlueprintProfessionalInterviewAnswers',
  'createdAgent: false',
  'routingActivated: false',
])

assertExcludes('src/main/modules/tools/agent-interaction-tool-defs.ts', [
  'propose_specialist_blueprint',
  'confirm_specialist_blueprint',
  'rename_specialist_agent',
])
for (const relPath of [
  'src/main/modules/tools/builtins/propose-specialist-blueprint.ts',
  'src/main/modules/tools/builtins/confirm-specialist-blueprint.ts',
  'src/main/modules/tools/builtins/rename-specialist-agent.ts',
]) {
  if (fs.existsSync(path.join(ROOT, relPath))) fail(`retired live tool still exists: ${relPath}`)
}

assertIncludes('src/main/modules/agent-control/agents/specialist-blueprint-quality.ts', [
  "SPECIALIST_FOUNDATION_PACK_VERSION = 'p8g-9c.v1'",
  'SPECIALIST_FOUNDATION_PACK_SECTIONS',
  "heading: '## Operating Model'",
  'renderOperatingModel',
])

assertIncludes('docs/superpowers/plans/2026-06-20-p8g9b-p8g9c-professional-agent-designer-implementation.md', [
  'P8g-9b: a professional interview contract',
  'P8g-9c: a versioned foundation authoring pack',
  'No automatic specialist creation',
  'No active routing before confirmation',
])

assertIncludes('outputs/agent-audit/fix-plan/00-ROADMAP.md', [
  'P8g-9b professional interview contract',
  'P8g-9c foundation authoring pack',
])

console.log('[check-specialist-professional-designer-contract] OK')
