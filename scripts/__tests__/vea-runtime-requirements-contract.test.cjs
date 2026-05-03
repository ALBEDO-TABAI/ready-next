const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const requirementsPath = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'requirements.txt')

test('VEA runtime requirements include the PDF renderer dependency', () => {
  const requirements = readFileSync(requirementsPath, 'utf8').toLowerCase()
  assert.match(requirements, /^reportlab[<>=~!]/m)
})
