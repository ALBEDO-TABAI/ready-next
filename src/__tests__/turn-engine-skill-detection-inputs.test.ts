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
  assert.match(turnEngine, /buildSkillDetectionInputs/)
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
  // The matched text is captured once and reused by preflight hint arming,
  // preferred tool derivation, and inline context injection.
  assert.match(turnEngine, /(?:const|let) skillContextInjectionText = firstSkillMatch \? firstSkillMatch\.text : contextualUserInput/)
  assert.match(turnEngine, /rememberExplicitReferenceSkillHint\?\.\(\s*skillContextInjectionText,/)
  assert.match(turnEngine, /buildPreferredSkillToolNames\(\s*skillContextInjectionText,/)
  // Still fallback to contextualUserInput when the active-execution branch kicks in.
  assert.match(turnEngine, /firstSkillMatch\s*\?\s*firstSkillMatch\.text\s*:\s*contextualUserInput/)
})

test('turn-engine injects explicit skill context from the matched history input on retry turns', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assert.match(turnEngine, /previousPureUserInputs/)
  assert.match(turnEngine, /maybeInjectExplicitSkillContext\(\{[\s\S]*?userText:\s*skillContextInjectionText,/)
  assert.match(turnEngine, /(?:const|let) skillContextInjectionText = firstSkillMatch \? firstSkillMatch\.text : contextualUserInput/)
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
  assert.match(turnEngine, /\[skill_detection\][\s\S]*preferredSkillTools=/)
})

test('turn-engine derives preferredSkillToolNames via the skill-context binding gate', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  // Stage 4 W3 cutover: preferredSkillToolNames is initially derived from the
  // legacy skill-context disjunction (`hasExplicitSkill || hasActiveSkill`)
  // and then reconciled with the W3 SkillToolAuthorization frame steering.
  // The legacy disjunction is preserved as a transitional bootstrap: when no
  // turnFrame.steering arrives (e.g. early in a turn before the authorization
  // resolves), the gate still has to know whether to engage skill-bound
  // filtering. The frame must not blindly overwrite a typed skill action with
  // primitive-only steering, or a restart turn can lose the real skill action.
  // This pins both stages of the derivation chain — both must remain present
  // until SkillToolAuthorization fully replaces the bootstrap.
  assert.match(turnEngine, /legacyPreferredSkillToolNames/)
  assert.match(turnEngine, /shouldBindSkillContextForTurn\s*&&\s*hasExplicitSkill/)
  assert.match(turnEngine, /choosePreferredSkillToolNamesFromFrame/)
  assert.match(turnEngine, /preferredSkillToolNames\s*=\s*choosePreferredSkillToolNamesFromFrame\(\s*turnFrame,\s*preferredSkillToolNames\s*\)/)
})

test('turn-engine suppresses implicit continuation lookup when a retry resolves to an explicit skill', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assert.match(turnEngine, /shouldSuppressImplicitContinuation/)
  assert.match(turnEngine, /hasExplicitSkill/)
  // Phase 2.4 — turn-engine's implicit continuation gate must go through the
  // unified resume lexicon (`matchesResumeIntent` w/ 'anywhere' mode), not an
  // inline regex. The lexicon covers natural phrasings like "你需要从头跑一轮"
  // / "重新跑一次" that the original 5-token regex silently dropped. Pinning
  // the lexicon call here so a future refactor that re-inlines the regex
  // gets caught.
  assert.match(
    turnEngine,
    /!\s*shouldSuppressImplicitContinuation\s*&&\s*\([\s\S]*?matchesResumeIntent\(\s*continuationHintText\s*,\s*'anywhere'\s*\)/,
  )
  assert.match(turnEngine, /from '\.\/contracts\/resume-lexicon'/, 'turn-engine imports the lexicon module')
})

test('turn-engine treats config repair turns as skill resume candidates', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const skillTurnIdentity = readWorkspaceFile('src/main/modules/agent-control/skills/skill-turn-identity.ts')

  assert.match(turnEngine, /matchesConfigRepairIntent/)
  assert.match(turnEngine, /isConfigRepairTurnDetected/)
  assert.match(turnEngine, /isSkillResumeTurnDetected/)
  // Stage 4 W3 moved the "no recent skill task is available to resume after
  // config repair turn" log emission out of turn-engine and into the
  // SkillTurnIdentity resolver. The diagnostic must still exist somewhere on
  // the resume path; we now pin it to its current home.
  assert.match(skillTurnIdentity, /No recent skill task is available to resume/)
})

test('turn-engine synthesizes skill context from an armed reference hint on retry-only turns', () => {
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const skillTurnIdentity = readWorkspaceFile('src/main/modules/agent-control/skills/skill-turn-identity.ts')

  // turn-engine still calls getCurrentReferenceSkillHint?.(request.sessionId)
  // directly during its W3 SkillTurnIdentity resolution pass.
  assert.match(turnEngine, /getCurrentReferenceSkillHint\?\.\(request\.sessionId\)/)
  // The synthesised context-text and the rearm metric were moved into
  // skill-turn-identity.ts as part of the W3 cutover. Pin them to the new
  // home so a regression that re-inlines them in turn-engine still passes
  // here (this test asserts they exist on the resume path, regardless of
  // file location).
  assert.match(skillTurnIdentity, /用户希望继续使用 skill "\$\{[^}]+\}"/)
  assert.match(skillTurnIdentity, /reference_skill_rearmed_from_current_hint/)
})
