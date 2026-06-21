#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const failures = []
const fail = (message) => failures.push(message)

const files = {
  handoff: 'src/main/modules/agent-control/agents/handoff-proposal.ts',
  toolDefs: 'src/main/modules/tools/agent-interaction-tool-defs.ts',
  proposeHandoff: 'src/main/modules/tools/builtins/propose-handoff.ts',
  renderer: 'src/renderer',
  preload: 'src/preload',
}

for (const rel of [files.handoff, files.toolDefs, files.proposeHandoff]) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing file: ${rel}`)
}

function extractFunction(source, marker, endMarker) {
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  return source.slice(start, end > start ? end : undefined)
}

if (failures.length === 0) {
  const handoff = read(files.handoff)
  const toolDefs = read(files.toolDefs)
  const proposeHandoff = read(files.proposeHandoff)

  if (!/export\s+const\s+HANDOFF_NEW_SESSION_OPTION\s*=/.test(handoff)) {
    fail('HANDOFF_NEW_SESSION_OPTION must remain exported as a retained asset.')
  }
  if (!/kind:\s*'adopted_new_session'/.test(handoff)) {
    fail('HandoffProposalOutcome must retain adopted_new_session.')
  }
  if (!/prefillVerbatim/.test(handoff)) {
    fail('prefillVerbatim must remain in the retained new-session branch.')
  }
  if (!/answer\s*===\s*HANDOFF_NEW_SESSION_OPTION/.test(handoff)) {
    fail('runHandoffProposal must retain the HANDOFF_NEW_SESSION_OPTION branch.')
  }
  if (!/unwired-handoff-newsession/.test(handoff)) {
    fail('retained new-session branch must carry the unwired-handoff-newsession marker.')
  }
  if (!/case\s+'adopted_new_session'/.test(proposeHandoff)) {
    fail('executeProposeHandoff outcome mapping must retain adopted_new_session.')
  }

  const questionBlock = extractFunction(
    handoff,
    'const question = {',
    'let answer: string | null = null',
  )
  if (!questionBlock) {
    fail('handoff proposal question block not found.')
  } else {
    const optionsMatch = questionBlock.match(/options:\s*\[([^\]]*)\]/s)
    if (!optionsMatch) {
      fail('handoff proposal question.options block not found.')
    } else {
      const optionsSource = optionsMatch[1]
      if (/HANDOFF_NEW_SESSION_OPTION/.test(optionsSource)) {
        fail('production handoff card must not expose HANDOFF_NEW_SESSION_OPTION.')
      }
      if (!/HANDOFF_ADOPT_OPTION/.test(optionsSource) || !/HANDOFF_REJECT_OPTION/.test(optionsSource)) {
        fail('production handoff card must still expose adopt and reject options.')
      }
    }
  }

  const descriptionMatch = toolDefs.match(/const\s+PROPOSE_HANDOFF_DESCRIPTION\s*=\s*\[([\s\S]*?)\]\.join\('\\n'\)/)
  if (!descriptionMatch) {
    fail('PROPOSE_HANDOFF_DESCRIPTION block not found.')
  } else {
    const description = descriptionMatch[1]
    if (/新会话接手|新会话|预填原话|new session/i.test(description)) {
      fail('agent_propose_handoff description must not advertise the hidden new-session option.')
    }
    if (!/采纳|转给/.test(description) || !/拒绝/.test(description)) {
      fail('agent_propose_handoff description must still describe the exposed adopt/reject choices.')
    }
  }

  for (const rel of [files.renderer, files.preload]) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    const stack = [abs]
    while (stack.length > 0) {
      const current = stack.pop()
      const stat = fs.statSync(current)
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry))
        continue
      }
      if (!/\.(ts|tsx)$/.test(current)) continue
      const source = fs.readFileSync(current, 'utf8')
      if (/prefillVerbatim/.test(source)) {
        fail(`${path.relative(root, current)} must not consume prefillVerbatim in P5b B1.`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[check-unwired-handoff-newsession] failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[check-unwired-handoff-newsession] ok')
