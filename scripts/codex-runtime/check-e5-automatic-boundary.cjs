const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const root = resolve(__dirname, '../..')
const samples = {
  below: {
    path: 'outputs/codex-runtime-e5/3f03b6ce39bdf09ef02946019d591c4045fe5197/profile/e5-gateway-capture.ndjson',
    sha256: 'b3b442c32df56aaf179a1e3d9d33fc9cee4afdc084120a89d14b9c53c10d0b5a',
  },
  triggered: {
    path: 'outputs/codex-runtime-e5/8919f695e44f5565439c698bac673427dafe6eeb/profile/e5-gateway-capture.ndjson',
    sha256: '554f683103a1c25d3b1733c871c1000798c1e9d873c68c525987d3a2882cf023',
  },
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function readSample(sample) {
  const body = readFileSync(resolve(root, sample.path))
  assert(createHash('sha256').update(body).digest('hex') === sample.sha256, `${sample.path}:sha256`)
  return body.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function maxInput(entry) {
  return Math.max(0, ...(entry.inputItems || []).map((item) => item.maxStringCharacters || 0))
}

function assertCommon(entries, label) {
  assert(entries.length > 0, `${label}:empty`)
  assert(new Set(entries.map((entry) => entry.threadId)).size === 1, `${label}:thread_drift`)
  assert(new Set(entries.map((entry) => entry.proofSentinelDigest)).size === 1, `${label}:sentinel_drift`)
  assert(entries.every((entry) => entry.readyResourceReferenceCount === 0), `${label}:resource_reference`)
  assert(entries.every((entry) => Number.isSafeInteger(entry.proofSentinelOccurrences)), `${label}:sentinel_count`)
}

const below = readSample(samples.below)
assertCommon(below, 'below')
assert(below.length === 3 && below.every((entry) => entry.requestKind === 'product'), 'below:kind_sequence')
assert(new Set(below.map((entry) => entry.turnId)).size === 3, 'below:turn_count')
assert(below.every((entry) => entry.toolCount === 34 && entry.toolNames.length === 34), 'below:tool_surface')
assert(below.every((entry) => maxInput(entry) === 444126), 'below:threshold_fixture')
assert(below.every((entry) => entry.proofSentinelOccurrences >= 2), 'below:sentinel_continuity')

const triggered = readSample(samples.triggered)
assertCommon(triggered, 'triggered')
assert(triggered.length === 4, 'triggered:entry_count')
assert(
  triggered.map((entry) => entry.requestKind).join(',')
    === 'product,automatic_compaction,product,product',
  'triggered:kind_sequence',
)
const [initial, automatic, successor, followUp] = triggered
assert(automatic.turnId === successor.turnId, 'triggered:successor_turn_identity')
assert(initial.turnId !== automatic.turnId && followUp.turnId !== automatic.turnId, 'triggered:turn_identity')
assert(automatic.toolCount === 0 && automatic.toolNames.length === 0, 'triggered:automatic_tool_surface')
assert([initial, successor, followUp].every((entry) => (
  entry.toolCount === 34 && entry.toolNames.length === 34
)), 'triggered:product_tool_surface')
assert(maxInput(initial) === 464126 && maxInput(automatic) === 464126, 'triggered:pre_compaction_size')
assert(maxInput(successor) === 79888 && maxInput(followUp) === 79888, 'triggered:post_compaction_size')
assert(successor.proofSentinelOccurrences >= 1 && followUp.proofSentinelOccurrences >= 1,
  'triggered:sentinel_continuity')

console.log('Codex runtime E5 automatic boundary replay PASS')
