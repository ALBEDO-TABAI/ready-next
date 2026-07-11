const fs = require('node:fs')
const source = fs.readFileSync('src/main/modules/agent-control/agents/specialist-task-evolution-proposals.ts', 'utf8')
const failures = []
if (!source.includes('getRunExecutionBinding')) failures.push('learning does not read stored run binding')
if (!source.includes('binding.effectiveAgentId')) failures.push('learning does not attribute to effective execution agent')
if (source.includes('String(projection.ownerAgentId')) failures.push('learning still attributes from current projection owner')
if (!source.includes("status: 'staged'")) failures.push('learning proposal is not staged')
if (failures.length) throw new Error(failures.join('\n'))
console.log('agent learning attribution gate: ok')
