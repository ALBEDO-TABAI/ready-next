const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { check } = require('../check-unwired-capability-markers.cjs')

function write(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-p5-unwired-'))
  write(root, 'docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md', '任务包体系未启用\n')
  write(root, 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md', '自动模型维护回合已退役\n')
  write(root, 'src/main/modules/agent-control/quality/packet-fields.ts', 'export function validatePacketFields() {}\n')
  write(root, 'src/main/modules/agent-control/quality/packet-compiler.ts', '/** P5c/C22 unwired: not in production path. */\nexport const compiler = 1\n')
  write(root, 'src/main/modules/agent-control/quality/packet-dispatch.ts', '/** P5c/C22 unwired: not in production path. */\nimport type { compiler } from "./packet-compiler"\nexport const dispatch = 1\n')
  write(root, 'src/main/modules/agent-control/quality/packet-failure.ts', '/** P5c/C22 unwired: not in production path. */\nimport { compiler } from "./packet-compiler"\nexport const failure = compiler\n')
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'export const runtime = true\n')
  return root
}

test('passes for marked dormant modules, exact intra-cluster imports, test imports, and live surfaces', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/repositories/task-projection-repository.ts', 'import { validatePacketFields } from "../agent-control/quality/packet-fields"\n')
  write(root, 'src/__tests__/packet-compiler-gate.test.ts', 'import { compiler } from "../main/modules/agent-control/quality/packet-compiler"\n')
  const result = check({ root })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('fails when live packet-fields is marked unwired', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/quality/packet-fields.ts', '/** P5c/C22 unwired: not in production path. */\nexport function validatePacketFields() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('packet-fields.ts') && error.includes('live validation')))
})

test('fails when the P5d enforce doc omits the model-maintenance retirement status', () => {
  const root = makeRoot()
  write(root, 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md', 'maintenance docs\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('自动模型维护回合已退役')))
})
