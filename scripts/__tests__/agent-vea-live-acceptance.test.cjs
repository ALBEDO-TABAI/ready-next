const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')

const scriptPath = join(__dirname, '..', 'agent-vea-live-acceptance.ts')

test('VEA live acceptance harness does not synthesize missing audiovisual artifacts', () => {
  const source = readFileSync(scriptPath, 'utf8')

  assert.match(source, /inspectPendingAudiovisualHandoffs/)
  assert.doesNotMatch(source, /fulfillPendingAudiovisualHandoffs/)
  assert.doesNotMatch(source, /writeFileSync\s*\(/)
  assert.doesNotMatch(source, /generateAudiovisualBody/)
  assert.doesNotMatch(source, /simpleDiagramSvg/)
  assert.doesNotMatch(source, /A Place for People/)
  assert.doesNotMatch(source, /Notion/)
})

test('VEA live acceptance harness repairs validator feedback generically', () => {
  const source = readFileSync(scriptPath, 'utf8')

  assert.match(source, /validation_errors\.json/)
  assert.match(source, /applyValidationHeadingLiterals/)
  assert.match(source, /repairHandoffValidationErrors\(afterOutputDir,\s*args\.agentContext\)/)
  assert.match(source, /inspectArtifacts\(resolveEffectiveOutputDir\(args\.opts\.outputDir\)\)/)
  assert.doesNotMatch(source, /p4ahGSFTY-c/)
  assert.doesNotMatch(source, /LEMONADE/)
  assert.doesNotMatch(source, /谜面清单/)
  assert.doesNotMatch(source, /预设读者/)
})
