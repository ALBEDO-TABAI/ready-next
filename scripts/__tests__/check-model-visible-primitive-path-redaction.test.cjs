'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-model-visible-primitive-path-redaction.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-visible-primitive-redaction-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeBaseline(root) {
  write(root, 'src/main/modules/agent-control/tools-runtime/model-visible-tool-output.ts', `
export function buildModelVisibleToolResultPayload(output) {
  const normalized = normalizeToolExecutionOutput(output)
  return {
    text: redactModelVisibleToolText(normalized.text),
    shape: normalized.shape,
    data: redactModelVisibleValue(normalized.data),
    projectionPatch: redactModelVisibleValue(normalized.projectionPatch),
    framePatch: redactModelVisibleValue(normalized.framePatch),
    interactionHint: normalized.interactionHint,
  }
}
`)
  write(root, 'src/main/modules/tools/skill-primitives/host-path-redactor.ts', `
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
function currentResourcesPath() { return '' }
export function redactHostPaths(text) {
  let out = text
  out = redactStaticRoot(out, tmpdir(), '<tmp>')
  out = redactStaticRoot(out, currentResourcesPath(), '<app>')
  return out
}
function redactStaticRoot(text, root, replacement) {
  realpathSync.native(root)
  return text
}
`)
}

test('gate passes for current primitive model-visible redaction shape', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when framePatch is not redacted in the model-visible payload', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/tools-runtime/model-visible-tool-output.ts', `
export function buildModelVisibleToolResultPayload(output) {
  const normalized = normalizeToolExecutionOutput(output)
  return {
    text: redactModelVisibleToolText(normalized.text),
    shape: normalized.shape,
    data: redactModelVisibleValue(normalized.data),
    projectionPatch: redactModelVisibleValue(normalized.projectionPatch),
    framePatch: normalized.framePatch,
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('missing_model_visible_redaction_field:framePatch'))
})

test('gate fails when contextModifier is exposed to the model-visible payload', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/tools-runtime/model-visible-tool-output.ts', `
export function buildModelVisibleToolResultPayload(output) {
  const normalized = normalizeToolExecutionOutput(output)
  return {
    text: redactModelVisibleToolText(normalized.text),
    shape: normalized.shape,
    data: redactModelVisibleValue(normalized.data),
    projectionPatch: redactModelVisibleValue(normalized.projectionPatch),
    framePatch: redactModelVisibleValue(normalized.framePatch),
    contextModifier: redactModelVisibleValue(normalized.contextModifier),
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('model_visible_internal_context_modifier'))
})

test('gate fails when envelope is exposed to the model-visible payload', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/tools-runtime/model-visible-tool-output.ts', `
export function buildModelVisibleToolResultPayload(output) {
  const normalized = normalizeToolExecutionOutput(output)
  return {
    text: redactModelVisibleToolText(normalized.text),
    shape: normalized.shape,
    data: redactModelVisibleValue(normalized.data),
    projectionPatch: redactModelVisibleValue(normalized.projectionPatch),
    framePatch: redactModelVisibleValue(normalized.framePatch),
    envelope: normalized.envelope,
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('model_visible_internal_envelope'))
})

test('gate fails when canonical static root redaction support is removed', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/tools/skill-primitives/host-path-redactor.ts', `
import { tmpdir } from 'node:os'
function currentResourcesPath() { return '' }
export function redactHostPaths(text) {
  let out = text
  out = redactStaticRoot(out, tmpdir(), '<tmp>')
  out = redactStaticRoot(out, currentResourcesPath(), '<app>')
  return out
}
function redactStaticRoot(text, root, replacement) {
  return text
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('missing_canonical_static_root_redaction'))
})
