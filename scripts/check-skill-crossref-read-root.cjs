#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const resolver = read('src/main/modules/agent-control/runtime-core/turn-frame-resolver.ts')
const orchestrator = read('src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts')
const preparation = read('src/main/modules/agent-control/runtime-core/agent-sdk-turn-preparation.ts')
const readHandler = read('src/main/modules/tools/skill-primitives/read-artifact.ts')
const writeHandler = read('src/main/modules/tools/skill-primitives/write-artifact.ts')
const exportHandler = read('src/main/modules/tools/skill-primitives/export-artifact.ts')
const skillsTools = read('src/main/modules/tools/skills-tools.ts')
const toolRuntime = read('src/main/modules/agent-control/tools-runtime/tool-runtime.ts')
const violations = []

if (!/deriveChainedSkillReadRoots/.test(resolver) || !/sibling_asset/.test(resolver) || !/sibling_output/.test(resolver)) {
  violations.push('chained sibling read-root derivation is missing')
}

// The live orchestrator delegates deterministic preparation to its leaf; that
// leaf must seed chained roots into the READ-ONLY channel, never the
// write-eligible `activeArtifactRoots`.
if (!/prepareAgentSdkTurn\s*\(/.test(orchestrator)) {
  violations.push('orchestrator does not invoke the live turn-preparation owner')
}
if (!/deriveChainedSkillReadRoots/.test(preparation) || !/activeReadOnlyRoots\.push\(\.\.\.roots\.map/.test(preparation)) {
  violations.push('turn preparation does not seed chained read roots into the read-only channel')
}
if (/activeArtifactRoots\.push\(\.\.\.roots\.map/.test(`${orchestrator}\n${preparation}`)) {
  violations.push('chained read roots seeded into activeArtifactRoots (write-eligible) — read-only leak')
}

// The read-only union helper must exist and consult activeReadOnlyRoots; the
// read dispatch must resolve its additional roots through it.
if (!/function collectSkillReadArtifactRoots/.test(toolRuntime) || !/activeReadOnlyRoots/.test(toolRuntime)) {
  violations.push('collectSkillReadArtifactRoots read-only union helper missing')
}
if (!/collectSkillReadArtifactRoots\(runtimeContext\?\.activeFrame\)/.test(skillsTools)) {
  violations.push('read dispatch does not union read-only roots via collectSkillReadArtifactRoots')
}

// The handoff write-target resolver must read activeArtifactRoots ONLY — read-only
// roots must never reach a writable-target resolver (the R-XREAD write-leak fence).
if (!/resolvePendingSkillHandoffWriteTargets\(\s*runtimeContext\?\.activeFrame\?\.activeArtifactRoots/.test(skillsTools)) {
  violations.push('handoff write-target resolver must read activeArtifactRoots only')
}
if (/resolvePendingSkillHandoffWriteTargets\([^)]*activeReadOnlyRoots/.test(skillsTools)) {
  violations.push('read-only roots fed into the handoff write-target resolver — write leak')
}

// Read-only sibling roots must never enter write/export primitive dependencies.
if (/additionalAllowedReadRoots/.test(writeHandler) || /additionalAllowedReadRoots/.test(exportHandler)) {
  violations.push('read-only sibling roots leaked into write/export dependencies')
}

if (!/matchedRootKind/.test(readHandler) || !/resolveReadableExistingWithinAnyRoot/.test(readHandler)) {
  violations.push('read handler lacks root-kind observability or existing-path resolver')
}

if (violations.length > 0) {
  console.error(violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('skill cross-reference read-root contract: OK')
