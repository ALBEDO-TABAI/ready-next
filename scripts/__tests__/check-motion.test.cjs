'use strict'
// The motion gate (scripts/check-motion.cjs, motion language M6) on small samples.
const assert = require('node:assert/strict')
const test = require('node:test')
const { scanCss, scanTsx } = require('../check-motion.cjs')

const findings = (scan, text, file = 'sample') => {
  const found = []
  scan(file, text, kind => found.push(kind))
  return found.sort()
}

test('tokens pass; literal durations, curves, all and layout properties are caught', () => {
  assert.deepEqual(findings(scanCss, '.a { transition: opacity var(--rn-d-1) var(--rn-ease-std), transform var(--rn-d-2) var(--rn-ease-out); }'), [])
  assert.deepEqual(findings(scanCss, '.a { transition: opacity 160ms ease; }'), ['css-duration', 'css-easing'])
  assert.deepEqual(findings(scanCss, '.a { transition: all var(--rn-d-1) var(--rn-ease-std); }'), ['css-all'])
  assert.deepEqual(findings(scanCss, '.a { transition: width var(--rn-d-2) var(--rn-ease-out); }'), ['css-layout'])
  assert.deepEqual(findings(scanCss, '.a { animation: x .3s cubic-bezier(0.2, 0, 0, 1) both; }'), ['css-duration', 'css-easing'])
  assert.deepEqual(findings(scanCss, '.a { transition: var(--rn-d-2) var(--rn-ease-out); }'), ['css-all'], 'no property means all')
  assert.deepEqual(findings(scanCss, '.a { transition: var(--rn-d-2) var(--rn-ease-out) width; }'), ['css-layout'], 'the property may come last')
  assert.deepEqual(findings(scanCss, '.a { transition: none; }'), [])
  assert.deepEqual(findings(scanCss, '.a { transition: var(--rn-d-2) var(--rn-ease-out) all; }'), ['css-all'], 'all may come last')
})

test('loops may run linear, steps are not curves, instant changes and the reduced-motion idiom pass', () => {
  assert.deepEqual(findings(scanCss, '.a { animation: spin var(--rn-d-spin) linear infinite; }'), [])
  assert.deepEqual(findings(scanCss, '.a { animation: blink var(--rn-d-spin) steps(1, end) infinite; }'), [])
  assert.deepEqual(findings(scanCss, '.a { transition: visibility 0s linear var(--rn-d-2); }'), [])
  assert.deepEqual(findings(scanCss, '.a { transition-duration: .01ms !important; }'), [])
  assert.deepEqual(findings(scanCss, '.a { animation: spin 0.8s linear infinite; }'), ['css-duration'])
})

test('TSX: Tailwind durations, style strings, Element.animate numbers and easings are caught; tokens pass', () => {
  assert.deepEqual(findings(scanTsx, '<b className="transition-colors duration-150" />', 'a.tsx'), ['tw-duration'])
  assert.deepEqual(findings(scanTsx, '<b className="transition-colors duration-(--rn-d-1)" />', 'a.tsx'), [])
  assert.deepEqual(findings(scanTsx, "style={{ transition: 'transform 200ms ease' }}", 'a.tsx'), ['ts-literal'])
  assert.deepEqual(findings(scanTsx, "style={{ transition: 'transform var(--rn-d-2) var(--rn-ease-std)' }}", 'a.tsx'), [])
  assert.deepEqual(findings(scanTsx, "el.animate(frames, { duration: 1800 })", 'a.ts'), ['ts-literal'])
  assert.deepEqual(findings(scanTsx, "el.animate(frames, { duration: MOTION_MS.flash, easing: EASE_CSS.out })", 'a.ts'), [])
})
