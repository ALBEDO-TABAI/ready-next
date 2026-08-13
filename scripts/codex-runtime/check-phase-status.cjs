const path = require('node:path')
const {
  assert,
  assetRoot,
  readJson
} = require('./contract-lib.cjs')

async function main() {
  const requiredPhase = process.argv[2]
  const status = readJson(path.join(assetRoot, 'implementation-status.json'))

  assert(requiredPhase && status.phases[requiredPhase], `unknown_phase:${requiredPhase || 'missing'}`)
  assert(
    status.phases[requiredPhase] === 'passed',
    `codex_runtime_phase_not_passed:${requiredPhase}:${status.phases[requiredPhase]}:${status.failureCode}`
  )
  console.log(`Codex runtime ${requiredPhase} PASS`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
