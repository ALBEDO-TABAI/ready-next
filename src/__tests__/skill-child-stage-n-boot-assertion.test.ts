import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  assertStageNChildLoopInvariants,
  type StageNAssertionInputs,
  type StageNSkillSnapshot,
} from '../main/modules/agent-control/stage-n-boot-assertion'

function fixedLookup(table: Record<string, string>): (skillId: string, action: string) => string | null {
  return (skillId, action) => table[`${skillId}:${action}`] || null
}

function buildInputs(overrides: Partial<StageNAssertionInputs>): StageNAssertionInputs {
  return {
    skills: [],
    registeredDriverSkillIds: [],
    staticToolNameLookup: () => null,
    warn: () => {},
    ...overrides,
  }
}

const embeddedSkillWithLoop = (id: string, actions: string[]): StageNSkillSnapshot => ({
  id,
  source: 'embedded',
  childLoop: { actions },
})

const customSkillWithLoop = (id: string, actions: string[]): StageNSkillSnapshot => ({
  id,
  source: 'custom',
  childLoop: { actions },
})

describe('Stage N Phase 0.3 — boot assertion', () => {
  it('passes when embedded manifest has matching driver + static-name entries', () => {
    assert.doesNotThrow(() => {
      assertStageNChildLoopInvariants(buildInputs({
        skills: [embeddedSkillWithLoop('vea', ['pipeline', 'analyze'])],
        registeredDriverSkillIds: ['vea'],
        staticToolNameLookup: fixedLookup({
          'vea:pipeline': 'skill_pipeline',
          'vea:analyze': 'skill_analyze',
        }),
      }))
    })
  })

  it('throws when embedded manifest declares child_loop but no driver is registered', () => {
    assert.throws(
      () => assertStageNChildLoopInvariants(buildInputs({
        skills: [embeddedSkillWithLoop('vea', ['pipeline'])],
        registeredDriverSkillIds: [],
        staticToolNameLookup: fixedLookup({ 'vea:pipeline': 'skill_pipeline' }),
      })),
      /no driver registered: vea/,
    )
  })

  it('throws when embedded manifest action missing in static name table', () => {
    assert.throws(
      () => assertStageNChildLoopInvariants(buildInputs({
        skills: [embeddedSkillWithLoop('vea', ['pipeline'])],
        registeredDriverSkillIds: ['vea'],
        staticToolNameLookup: () => null,
      })),
      /missing in STATIC_SKILL_TOOL_NAMES_BY_ACTION: vea:pipeline/,
    )
  })

  it('reports both driver + static-name violations together', () => {
    let thrown: unknown = null
    try {
      assertStageNChildLoopInvariants(buildInputs({
        skills: [embeddedSkillWithLoop('vea', ['pipeline'])],
        registeredDriverSkillIds: [],
        staticToolNameLookup: () => null,
      }))
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof Error, 'expected violation to throw')
    const message = (thrown as Error).message
    assert.match(message, /no driver registered: vea/)
    assert.match(message, /missing in STATIC_SKILL_TOOL_NAMES_BY_ACTION: vea:pipeline/)
  })

  it('does NOT throw on custom skills with child_loop — emits warn instead', () => {
    const warns: string[] = []
    assert.doesNotThrow(() => {
      assertStageNChildLoopInvariants(buildInputs({
        skills: [customSkillWithLoop('rogue-custom', ['x'])],
        registeredDriverSkillIds: [],
        staticToolNameLookup: () => null,
        warn: (msg) => warns.push(msg),
      }))
    })
    assert.ok(
      warns.some((m) => m.includes('rogue-custom') && m.includes('Phase 0.4')),
      `expected warn naming the custom skill; got: ${warns.join(' | ')}`,
    )
  })

  it('skips skills with no child_loop without consulting drivers or static names', () => {
    let lookupCalls = 0
    assert.doesNotThrow(() => {
      assertStageNChildLoopInvariants(buildInputs({
        skills: [
          { id: 'plain-embedded', source: 'embedded' },
          { id: 'plain-custom', source: 'custom', childLoop: { actions: [] } },
        ],
        registeredDriverSkillIds: [],
        staticToolNameLookup: () => {
          lookupCalls += 1
          return null
        },
      }))
    })
    assert.equal(lookupCalls, 0, 'lookup should not be consulted for skills without child_loop')
  })
})
