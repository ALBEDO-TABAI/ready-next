#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const violations = []

const defs = read('src/main/modules/tools/agent-interaction-tool-defs.ts')
const handler = read('src/main/modules/tools/builtins/declare-completion-criteria.ts')
const repository = read('src/main/modules/repositories/task-projection-repository.ts')
const finalizer = read('src/main/modules/agent-control/runtime-core/run-finalizer-task-facts.ts')
const coverageTest = read('src/__tests__/completion-declaration-persistence.test.ts')

if (!/expected_outputs:\s*\{/.test(defs)) violations.push('declare_completion_criteria schema lacks expected_outputs')
if (!/expected_outputs_declared/.test(handler)) violations.push('producer lacks expected_outputs_declared metric')
if (!/expected_outputs_json/.test(repository)) violations.push('task projection repository does not persist expected outputs')
if (!/absorbTargets\(projection\.expectedOutputs\)/.test(finalizer)) violations.push('finalizer does not consume task-level declarations')
if (!/描述\.md[\s\S]*深读\.md/.test(coverageTest) || !/criteria_unsatisfied:c1/.test(coverageTest)) {
  violations.push('live-glue test does not prove two-declared/one-delivered rejection')
}

const forbidden = [
  /expectedOutputs\s*[:=][^\n]*(?:skillCount|envelopeCount|mentionedDomains)/,
  /coverageTargets\s*[:=][^\n]*(?:skillCount|envelopeCount|mentionedDomains)/,
]
for (const file of [
  'src/main/modules/agent-control/runtime-core/run-finalizer-task-facts.ts',
  'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts',
  'src/main/modules/tools/builtins/declare-completion-criteria.ts',
]) {
  const source = read(file)
  if (forbidden.some((pattern) => pattern.test(source))) violations.push(`${file} derives delivery count from a forbidden heuristic`)
}

if (violations.length > 0) {
  console.error(violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('delivery coverage producer contract: OK')
