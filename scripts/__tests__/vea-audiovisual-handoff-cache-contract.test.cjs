const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const handoffDir = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts', 'audiovisual', 'reporting')

test('VEA audiovisual handoff cache ignores volatile generated timestamps', () => {
  const python = `
import sys
sys.path.insert(0, ${JSON.stringify(handoffDir)})
import handoff

system = "system"
first = "# 视听剖析报告\\n\\n正文\\n\\n*生成时间：2026-05-03 10:00:00*"
second = "# 视听剖析报告\\n\\n正文\\n\\n*生成时间：2026-05-03 10:05:00*"
print(handoff._hash_prompt(system, first))
print(handoff._hash_prompt(system, second))
`
  const [first, second] = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
  }).trim().split('\n')
  assert.equal(first, second)
})

test('VEA audiovisual handoff cache hashes the task text shape written to disk', () => {
  const python = `
import sys
sys.path.insert(0, ${JSON.stringify(handoffDir)})
import handoff

system = "\\n## SVG 广告修辞结构图 — AGENT PROMPT\\n"
user = "\\n完整视听报告如下：\\n\\n正文\\n\\n*生成时间：2026-05-03 17:14:19*\\n\\n"
written_system = system.strip()
written_user = user.strip()
print(handoff._hash_prompt(system, user))
print(handoff._hash_prompt(written_system, written_user))
`
  const [raw, written] = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
  }).trim().split('\n')
  assert.equal(raw, written)
})
