const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const manifestPath = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'ready-skill.json')

test('VEA typed action timeout covers a full fresh pipeline run', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(
    Number(manifest.host_requirements?.default_action_timeout_ms || 0) >= 10_800_000,
    'video-expert-analyzer needs a 3-hour child action budget for high-scene-count videos',
  )
})
