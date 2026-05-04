const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const skillRoot = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer')

function runPython(source) {
  const result = spawnSync('python3', ['-c', source], {
    cwd: skillRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(skillRoot, 'scripts'),
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test('VEA prompt fidelity accepts Chinese scene evidence labels', () => {
  const output = runPython(`
from audiovisual.reporting import template_engine
text = "本节引用场景001、场景 002 和 Scene 003 作为证据。"
print(bool(template_engine._SCENE_EVIDENCE_RE.search(text)))
print(",".join(sorted(template_engine._distinct_scene_numbers(text))))
`)

  assert.equal(output, 'True\n1,2,3')
})
