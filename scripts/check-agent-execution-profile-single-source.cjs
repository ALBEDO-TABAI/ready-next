const fs = require('node:fs')

const runtime = fs.readFileSync('src/main/modules/agent-control/runtime-core/runtime.ts', 'utf8')
const codexBinding = fs.readFileSync('src/main/modules/agent-control/codex-runtime/codex-host-execution-binding.ts', 'utf8')
const executionProfile = fs.readFileSync('src/main/modules/agent-control/agents/agent-execution-profile.ts', 'utf8')
// The live Codex composition: its entry plus every factory it assembles.
const compositionDir = 'src/main/modules/agent-control/codex-runtime/composition'
const liveComposition = ['src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts',
  ...fs.readdirSync(compositionDir).filter((name) => name.endsWith('.ts')).map((name) => `${compositionDir}/${name}`)]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n')

const failures = []
if (!runtime.includes('createCodexHostExecutionBinding({ runId, ownerAgentIdAtStart })')) failures.push('Codex admission does not freeze the neutral host identity')
if (runtime.includes('profile: await this.executionProfileResolver.resolve(ownerAgentIdAtStart)')) failures.push('Codex admission still reads the archived execution profile')
if (!codexBinding.includes("ephemeralRole: 'codex_host'")) failures.push('Codex host binding is not explicitly neutral')
if (!codexBinding.includes("executionMaterialHash: 'codex_host_identity:v1'")) failures.push('Codex host binding lacks a versioned neutral material identity')
if (/AgentExecutionProfileResolver|PromptAssembly|persona|knowledge|routing/i.test(codexBinding)) failures.push('Codex host binding depends on retired semantic profile inputs')
if (!runtime.includes('AgentExecutionProfileResolver')) failures.push('runtime does not own one profile resolver')
if (!/new AgentExecutionProfileResolver\(\{\s*registry: this\.agentRegistry,?\s*\}\)/.test(runtime)) failures.push('runtime does not construct the fixed Ready profile resolver')
if (!executionProfile.includes("identity: 'ready-neutral:v1'")) failures.push('fixed Ready profile lacks a versioned neutral identity')
if (!executionProfile.includes("personaRef: 'ready-neutral'")) failures.push('fixed Ready profile is not neutral')
if (!executionProfile.includes('allowedKnowledgeRefs: []')) failures.push('fixed Ready profile still grants legacy knowledge references')
if (/personalityReader|getKnowledgeStore|readAsset|agent_personalities|agent_knowledge/.test(executionProfile)) failures.push('fixed Ready profile still reads retired persona or knowledge truth')
if (runtime.includes('getLatestOwnerAgentForScope(scopeId)')) failures.push('live runtime still reads latest scope task owner')
if (/setPersonaResolver|AgentExecutionProfileResolver|executionProfileResolver\s*\.\s*resolve/.test(liveComposition)) failures.push('the live Codex composition reinstalls the retired persona resolver')
if (failures.length) throw new Error(failures.join('\n'))
console.log('agent execution profile single-source gate: ok')
