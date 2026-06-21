'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-specialist-professional-designer-contract.cjs')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-professional-designer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seed(root, overrides = {}) {
  const files = {
    'src/shared/agent-specialist-blueprint-clarification.ts': [
      "SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION = 'p8g-9b.v1'",
      "'workScope'",
      "'boundaryExamples'",
      "'inputsKnowledgeTools'",
      'buildSpecialistBlueprintProfessionalInterviewContract',
      'compileSpecialistBlueprintProfessionalInterviewAnswers',
      'createdAgent: false',
      'routingActivated: false',
    ].join('\n'),
    'src/main/modules/tools/agent-interaction-tool-defs.ts': [
      'workScope、boundaryExamples、inputsKnowledgeTools',
      '不要把它们合成一道大作文题',
      'P8g-9c foundation pack',
      '原始 user_request_verbatim',
    ].join('\n'),
    'src/main/modules/tools/builtins/propose-specialist-blueprint.ts': [
      'buildSpecialistBlueprintProfessionalInterviewContract',
      'shouldUseProfessionalInterview',
      'renderSpecialistBlueprintProfessionalInterviewInstruction',
      "contractKind === 'professional_interview'",
    ].join('\n'),
    'src/main/modules/agent-control/agents/specialist-blueprint-quality.ts': [
      "SPECIALIST_FOUNDATION_PACK_VERSION = 'p8g-9c.v1'",
      'SPECIALIST_FOUNDATION_PACK_SECTIONS',
      "heading: '## Operating Model'",
      'renderOperatingModel',
    ].join('\n'),
    'docs/superpowers/plans/2026-06-20-p8g9b-p8g9c-professional-agent-designer-implementation.md': [
      'P8g-9b: a professional interview contract',
      'P8g-9c: a versioned foundation authoring pack',
      'No automatic specialist creation',
      'No active routing before confirmation',
    ].join('\n'),
    'outputs/agent-audit/fix-plan/00-ROADMAP.md': [
      'P8g-9b professional interview contract',
      'P8g-9c foundation authoring pack',
    ].join('\n'),
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function run(root) {
  return spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' })
}

test('professional designer contract gate passes aligned contract surfaces', (t) => {
  const root = makeRoot(t)
  seed(root)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-specialist-professional-designer-contract.*OK/)
})

test('professional designer contract gate fails when interview ids drift from tool text', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/tools/agent-interaction-tool-defs.ts': [
      '不要把它们合成一道大作文题',
      'P8g-9c foundation pack',
      '原始 user_request_verbatim',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /workScope/)
})

test('professional designer contract gate fails when foundation pack sections drift', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/agent-control/agents/specialist-blueprint-quality.ts': [
      "SPECIALIST_FOUNDATION_PACK_VERSION = 'p8g-9c.v1'",
      'SPECIALIST_FOUNDATION_PACK_SECTIONS',
      'renderOperatingModel',
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Operating Model/)
})

test('professional designer contract gate fails when runtime interview wiring is missing', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/tools/builtins/propose-specialist-blueprint.ts': [
      'buildSpecialistBlueprintProfessionalInterviewContract',
      'renderSpecialistBlueprintProfessionalInterviewInstruction',
      "contractKind === 'professional_interview'",
    ].join('\n'),
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /shouldUseProfessionalInterview/)
})
