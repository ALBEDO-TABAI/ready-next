import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createReadyLogoDotPattern } from '../shared/ready-logo-dots'

test('Ready startup logo resolves to sparse dot columns for loading animation', () => {
  const svg = readFileSync(resolve(process.cwd(), 'src/renderer/assets/ready-wordmark.svg'), 'utf8')
  const pattern = createReadyLogoDotPattern(svg, {
    xOffset: 139 * 4,
    yOffset: 137,
    matrixXStart: 75,
    matrixColumnStep: 139,
  })

  assert.ok(pattern.dots.length > 80)
  assert.ok(pattern.columnCount > 20)
  assert.ok(pattern.columnCount < 37)
  assert.equal(pattern.dots[0]?.columnIndex, 0)
  assert.ok(pattern.dots.every((dot) => dot.columnIndex >= 0 && dot.columnIndex < pattern.columnCount))
  assert.ok(pattern.dots.every((dot) => dot.x >= 556 && dot.y >= 137))
})
