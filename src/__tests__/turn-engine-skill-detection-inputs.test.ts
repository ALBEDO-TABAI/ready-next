import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// R1 source-pin contract test: turn-engine must check explicit-skill presence
// against primaryInstruction and pureUserText, not contextualUserInput alone.
//
// Why this matters: contextualUserInput can inherit a previous turn's widget
// attachment text (lastDocumentContextInput). When the user types "按
// novel_writer_system 续写" in turn N, contextualUserInput in turn N may
// actually hold the widget-attachment string from turn N-1, which doesn't
// contain the skill name. If preferredSkillToolNames derivation is gated only
// on contextualUserInput, the skill detection misses and the whole skill
// passthrough pipeline (Gap 1/2/3/4/5 in round 1) stays inactive.

test('turn-engine probes primaryInstruction AND pureUserText AND contextualUserInput for explicit skills', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  // The three input channels must all be fed into findExplicitlyRequestedSkills
  // via a dedupe'd collection.
  assert.match(turnEngine, /skillDetectionInputs/)
  assert.match(turnEngine, /requestEnvelope\.primaryInstruction/)
  assert.match(turnEngine, /requestEnvelope\.pureUserText/)
  // The old contextual-only gate must be gone: look for the specific pattern
  // "findExplicitlyRequestedSkills(contextualUserInput)" WITHOUT any reference
  // to primaryInstruction/pureUserText nearby.
  const oldPatternRegions = turnEngine.match(/findExplicitlyRequestedSkills\(contextualUserInput\)\.length > 0[\s\S]{0,400}/g) || []
  for (const region of oldPatternRegions) {
    assert.ok(
      /primaryInstruction|skillDetectionInputs/.test(region),
      'turn-engine retained the contextual-only skill detection pattern — R1 regression',
    )
  }
})

test('turn-engine chooses the matched input text when handing to buildPreferredSkillToolNames', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  // buildPreferredSkillToolNames should be called with firstSkillMatch.text
  // when an explicit skill was matched, not unconditionally with contextualUserInput.
  // This keeps the downstream action-tool lookup consistent with the matching text.
  assert.match(turnEngine, /buildPreferredSkillToolNames\(\s*firstSkillMatch/)
  // Still fallback to contextualUserInput when the active-execution branch kicks in.
  assert.match(turnEngine, /firstSkillMatch\s*\?\s*firstSkillMatch\.text\s*:\s*contextualUserInput/)
})

test('turn-engine emits a [skill_detection] log line for observability', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  // The diagnostic log line is the primary way to tell whether the gate
  // activated in production. Keep a source-level assertion on its existence
  // so we notice if it's ever removed.
  assert.match(turnEngine, /\[skill_detection\][\s\S]*primaryMatched=/)
  assert.match(turnEngine, /\[skill_detection\][\s\S]*contextualMatched=/)
  assert.match(turnEngine, /\[skill_detection\][\s\S]*pureMatched=/)
  assert.match(turnEngine, /\[skill_detection\][\s\S]*preferredSkillToolCount=/)
})

test('turn-engine preserves the active-execution fallback branch', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  // Active skill execution must still kick preferredSkillToolNames on even
  // when findExplicitlyRequestedSkills returns [] across all three inputs.
  // This is required so an in-flight skill can keep its tools available even
  // if the user's current turn is a bare "继续" / "嗯".
  assert.match(turnEngine, /hasExplicitSkill\s*\|\|\s*hasActiveSkill/)
  assert.match(turnEngine, /hasActiveSkillExecution\(request\.sessionId\)/)
})
