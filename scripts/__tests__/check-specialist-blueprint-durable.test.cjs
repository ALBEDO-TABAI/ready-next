'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-specialist-blueprint-durable.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-blueprint-durable-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeRuntime(root, body) {
  const file = path.join(root, 'src/main/modules/agent-control/agents/specialist-blueprint-runtime.ts')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

test('specialist blueprint durable gate fails on bare runtime stores', (t) => {
  const root = makeRoot(t)
  writeRuntime(root, `
import { SpecialistBlueprintConfirmationStore } from './specialist-blueprint-confirmation'
import { SpecialistBlueprintStore } from './specialist-blueprint-store'

const store = new SpecialistBlueprintStore()
const confirmation = new SpecialistBlueprintConfirmationStore()
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /bare SpecialistBlueprintStore/)
})

test('specialist blueprint durable gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-specialist-blueprint-durable.*OK/)
})
