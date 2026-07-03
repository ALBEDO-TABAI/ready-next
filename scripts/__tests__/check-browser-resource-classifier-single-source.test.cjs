'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-browser-resource-classifier-single-source.cjs')

const SHARED_REL = 'src/shared/browser-tab-resource-classifier.ts'
const RENDERER_DROP_REL = 'src/renderer/components/layout/fileTreeExternalDrop.ts'
const MAIN_ANALYSIS_REL = 'src/main/modules/rss-engine/item-analysis-manager.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resource-classifier-single-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writePassingHarness(root) {
  write(root, SHARED_REL, `
export function classifyBrowserTabResource() { return { canAttemptVisualAnalysis: false } }
`)
  write(root, RENDERER_DROP_REL, `
import { canAttemptVisualAnalysis } from '../../../shared/browser-tab-resource-classifier'
export function isLikelyVideoDropPayload(payload) { return canAttemptVisualAnalysis(payload.url) }
`)
  write(root, MAIN_ANALYSIS_REL, `
import { canAttemptVisualAnalysis, hasLikelyVideoResource } from '../../../shared/browser-tab-resource-classifier'
export function isLikelyVideoLink(url) { return hasLikelyVideoResource(url) }
export function canRunVisual(url) { return canAttemptVisualAnalysis(url) }
`)
}

test('gate passes when renderer and main consume the shared browser resource classifier', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when renderer keeps a local video classifier', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RENDERER_DROP_REL, `
import { canAttemptVisualAnalysis } from '../../../shared/browser-tab-resource-classifier'
const VIDEO_DROP_HOST_HINTS = ['youtube.com']
export function isLikelyVideoDropPayload(payload) { return canAttemptVisualAnalysis(payload.url) || VIDEO_DROP_HOST_HINTS.length > 0 }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('renderer_has_local_video_classifier')))
})

test('gate fails when main keeps a local video classifier', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, MAIN_ANALYSIS_REL, `
import { hasLikelyVideoResource } from '../../../shared/browser-tab-resource-classifier'
const VIDEO_HOST_HINTS = ['youtube.com']
export function isLikelyVideoLink(url) { return hasLikelyVideoResource(url) || VIDEO_HOST_HINTS.length > 0 }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('main_has_local_video_classifier')))
})

test('gate fails when the shared classifier export is missing', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, SHARED_REL, `export const classifier = {}`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('shared_missing_classifier_export')))
})
