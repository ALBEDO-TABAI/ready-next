/**
 * EP3-PK3 — channel dispatch is a STATIC table (three channels, no default
 * row, fail-fast on unknown); briefs carry the user's words byte-for-byte
 * (05 §4 最小传话); a resolved channel without an executor is a hard error,
 * never a silent fallback.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolvePacketChannel,
  buildPacketBrief,
  dispatchPacket,
  type PacketDispatchBrief,
  type PacketTraits,
} from '../main/modules/agent-control/quality/packet-dispatch'
import { createSkillChildSubAgentFromPersisted } from '../main/modules/agent-control/skills/skill-child-sub-agent-factory'
import type { SkillChildRunPayload, SkillChildLaunchParams } from '../main/modules/agent-control/skills/skill-child-run-types'

// the awkward shape is the point: trailing spaces, newline, full-width
// punctuation — byte-for-byte means NONE of it is normalized away
const VERBATIM = '  帮我盯三个平台的行情，明早九点前给我对比！！\n（小红书优先）  '

const traits = (over: Partial<PacketTraits> = {}): PacketTraits =>
  ({ kind: 'general', needsConversationContext: false, longRunningOrParallel: false, ...over })

const child = (over: Partial<{ title: string; deliverable: string; contextRefs: string[] }> = {}) =>
  ({ title: '子包', deliverable: '对比报告', contextRefs: ['card:xhs'], ...over })

test('static channel table: three channels by traits, no default row for unknown kinds', () => {
  assert.equal(resolvePacketChannel(traits({ needsConversationContext: true })), 'chat_turn')
  assert.equal(resolvePacketChannel(traits({ longRunningOrParallel: true })), 'subagent')
  assert.equal(resolvePacketChannel(traits()), 'chat_turn', 'general default leg stays in-session')
  assert.equal(resolvePacketChannel(traits({ kind: 'browser_collection' })), 'background_task')
  assert.equal(resolvePacketChannel(traits({ kind: 'skill_long_task' })), 'background_task')
  // conversation-context flag never drags background work into chat
  assert.equal(
    resolvePacketChannel(traits({ kind: 'browser_collection', needsConversationContext: true })),
    'background_task',
  )
  assert.throws(() => resolvePacketChannel(traits({ kind: 'telepathy' as never })), /unknown packet kind.*fail-fast/)
})

test('three channels end-to-end with fake executors; the brief arrives byte-for-byte', async () => {
  const seen: Array<{ channel: string; brief: PacketDispatchBrief }> = []
  const executors = {
    chat_turn: (brief: PacketDispatchBrief) => { seen.push({ channel: 'chat_turn', brief }); return 'chat-ok' },
    subagent: async (brief: PacketDispatchBrief) => { seen.push({ channel: 'subagent', brief }); return 'sub-ok' },
    background_task: (brief: PacketDispatchBrief) => { seen.push({ channel: 'background_task', brief }); return 'bg-ok' },
  }
  const brief = buildPacketBrief({ userRequestVerbatim: VERBATIM, child: child() })

  const chat = await dispatchPacket({ brief, traits: traits({ needsConversationContext: true }), executors })
  const sub = await dispatchPacket({ brief, traits: traits({ longRunningOrParallel: true }), executors })
  const background = await dispatchPacket({ brief, traits: traits({ kind: 'skill_long_task' }), executors })

  assert.deepEqual(
    [chat, sub, background].map((entry) => [entry.channel, entry.result]),
    [['chat_turn', 'chat-ok'], ['subagent', 'sub-ok'], ['background_task', 'bg-ok']],
  )
  for (const entry of seen) {
    assert.equal(entry.brief.userRequestVerbatim, VERBATIM, `${entry.channel}: 原话逐字，一个字节不许动`)
    assert.deepEqual(entry.brief.contextRefs, ['card:xhs'], 'refs are structured, not prose')
  }
})

test('brief building: empty verbatim rejected; bad refs rejected; deliverable required; verbatim untouched', () => {
  assert.throws(() => buildPacketBrief({ userRequestVerbatim: '', child: child() }), /原话逐字|userRequestVerbatim/)
  assert.throws(
    () => buildPacketBrief({ userRequestVerbatim: 'x', child: child({ contextRefs: ['转'.repeat(301)] }) }),
    /contextRefs/,
  )
  assert.throws(() => buildPacketBrief({ userRequestVerbatim: 'x', child: child({ deliverable: ' ' }) }), /deliverable/)
  const brief = buildPacketBrief({ userRequestVerbatim: VERBATIM, child: child() })
  assert.equal(brief.userRequestVerbatim, VERBATIM, 'no trim / normalization / truncation')
})

test('a resolved channel without an executor is a hard error — no silent fallback', async () => {
  const brief = buildPacketBrief({ userRequestVerbatim: 'x', child: child() })
  await assert.rejects(
    dispatchPacket({ brief, traits: traits({ kind: 'browser_collection' }), executors: { chat_turn: () => 'nope' } }),
    /no executor registered for channel background_task/,
  )
})

test('skill-child factory forwards userRequestVerbatim byte-for-byte into launch params', async () => {
  let capturedLaunch: SkillChildLaunchParams | null = null
  const payload = {
    version: 1, childRunId: 'child-1', kind: 'skill', parentScopeId: 's1', parentSessionId: 'sess1',
    skillId: 'skill-x', skillName: null, requestedAction: 'run', requestedInput: {},
    singleFlightKey: 'k', parentNextHint: 'wait' as never, outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json', eventLogPath: '/tmp/out/events.jsonl',
    status: 'running', closeEvent: null,
    userRequestVerbatim: VERBATIM,
  } as unknown as SkillChildRunPayload
  await createSkillChildSubAgentFromPersisted({
    payload,
    driver: {
      canResume: () => true,
      createInitialState: async (launch: SkillChildLaunchParams) => { capturedLaunch = launch; return {} as never },
    } as never,
    executeAction: (() => { throw new Error('not executed in this test') }) as never,
  })
  assert.ok(capturedLaunch, 'driver received launch params')
  assert.equal(capturedLaunch!.userRequestVerbatim, VERBATIM, '技能子进程注入逐字断言（I4 技能子项）')
})
