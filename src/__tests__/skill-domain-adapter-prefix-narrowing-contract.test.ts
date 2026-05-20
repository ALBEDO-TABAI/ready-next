import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterAllowedToolNamesByPrefixes,
  logPrefixNarrowing,
} from '../main/modules/agent-control/domain-adapters/domain-adapter'

// R2 contract tests: pin the second-gate allowedToolNames narrowing semantics
// of the domain adapters. These narrowing steps are not obvious from reading
// turn-engine alone, and were a blind spot during the first fix round. The
// tests here assert:
//   1. Each domain's declared TOOL_PREFIXES list admits the tools the domain
//      depends on (including cross-domain shared memory/session tools).
//   2. filterAllowedToolNamesByPrefixes returns null (= unrestricted passthrough)
//      when the filter produces an empty set — this is the "0 matches = no gate"
//      reverse-intuition that bit us once before.
//   3. logPrefixNarrowing's format is stable so log aggregation queries survive
//      future refactors.

const SKILL_TOOL_PREFIXES = ['skill_', 'memory_', 'session_']
const RSS_TOOL_PREFIXES = ['rss_', 'skill_rss_', 'memory_', 'session_']
const CALENDAR_TOOL_PREFIXES = ['calendar_', 'memory_', 'session_']
const FEISHU_TOOL_PREFIXES = ['feishu_', 'memory_', 'session_']

test('skill adapter prefix narrowing keeps skill_*, memory_*, session_* and strips everything else', () => {
  const input = [
    'skill_get_state',
    'skill_novel_writer_system_read_skill',
    'memory_save',
    'session_recall',
    'document_open_tab',
    'browser_click',
    'rss_list',
  ]
  const filtered = filterAllowedToolNamesByPrefixes(input, SKILL_TOOL_PREFIXES)
  assert.ok(filtered !== null)
  assert.deepEqual(filtered!.sort(), [
    'memory_save',
    'session_recall',
    'skill_get_state',
    'skill_novel_writer_system_read_skill',
  ].sort())
})

test('skill adapter prefix narrowing returns null (unrestricted) when input has no matching prefix', () => {
  const input = ['document_open_tab', 'browser_click']
  const filtered = filterAllowedToolNamesByPrefixes(input, SKILL_TOOL_PREFIXES)
  assert.equal(filtered, null)
})

test('rss adapter keeps both rss_* and skill_rss_* tools', () => {
  const input = [
    'rss_list',
    'rss_add',
    'skill_rss_update',
    'skill_rss_status',
    'skill_novel_writer_system_read_skill', // non-rss skill — must drop
    'memory_save',
  ]
  const filtered = filterAllowedToolNamesByPrefixes(input, RSS_TOOL_PREFIXES)
  assert.ok(filtered !== null)
  assert.ok(filtered!.includes('rss_list'))
  assert.ok(filtered!.includes('skill_rss_update'))
  assert.ok(filtered!.includes('memory_save'))
  // skill_rss_* matches because 'skill_' prefix matches too, so we need to
  // ensure: NON-skill_rss_* skill tools are NOT kept under RSS adapter. But
  // wait — 'skill_' IS in the RSS prefixes list? Actually no: the RSS list is
  // ['rss_', 'skill_rss_', 'memory_', 'session_'] — so skill_novel_writer_...
  // (which starts with 'skill_') does match 'skill_rss_' as prefix? No, because
  // startsWith('skill_rss_') on 'skill_novel_...' is false. Good.
  assert.ok(!filtered!.includes('skill_novel_writer_system_read_skill'))
})

test('calendar adapter strips skill_* (including hypothetical skill_calendar_* unless added)', () => {
  const input = [
    'calendar_create_event',
    'calendar_list_events',
    'memory_save',
    'session_recall',
    'skill_get_state',
    'skill_novel_writer_system_read_skill',
  ]
  const filtered = filterAllowedToolNamesByPrefixes(input, CALENDAR_TOOL_PREFIXES)
  assert.ok(filtered !== null)
  assert.ok(filtered!.includes('calendar_create_event'))
  assert.ok(filtered!.includes('memory_save'))
  // This is the INTENTIONAL domain isolation — calendar does not co-host
  // skill workflows. Removing this assertion requires a deliberate decision.
  assert.ok(!filtered!.includes('skill_get_state'))
  assert.ok(!filtered!.includes('skill_novel_writer_system_read_skill'))
})

test('feishu adapter strips skill_* tools entirely (same deterministic-only contract)', () => {
  const input = [
    'feishu_send_message',
    'memory_save',
    'skill_get_state',
    'skill_novel_writer_system_read_skill',
  ]
  const filtered = filterAllowedToolNamesByPrefixes(input, FEISHU_TOOL_PREFIXES)
  assert.ok(filtered !== null)
  assert.ok(filtered!.includes('feishu_send_message'))
  assert.ok(filtered!.includes('memory_save'))
  assert.ok(!filtered!.includes('skill_get_state'))
})

test('logPrefixNarrowing emits a stable, parseable line with all required fields', () => {
  const lines: string[] = []
  const log = (message: string) => lines.push(message)
  logPrefixNarrowing(
    log,
    'skill',
    ['skill_get_state', 'document_open_tab', 'browser_click'],
    ['skill_get_state'],
    SKILL_TOOL_PREFIXES,
  )
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.match(line, /^\[domain_adapter_prefix_narrowing\]/)
  assert.match(line, /domain=skill/)
  assert.match(line, /inputCount=3/)
  assert.match(line, /outputCount=1/)
  assert.match(line, /prefixes=skill_\|memory_\|session_/)
  // Dropped sample shows what was stripped (up to 3), to aid debugging.
  assert.match(line, /droppedSample=document_open_tab,browser_click/)
})

test('logPrefixNarrowing reports unrestricted_passthrough when narrowing returns null', () => {
  const lines: string[] = []
  const log = (message: string) => lines.push(message)
  logPrefixNarrowing(
    log,
    'skill',
    ['document_open_tab', 'browser_click'],
    null,
    SKILL_TOOL_PREFIXES,
  )
  assert.equal(lines.length, 1)
  assert.match(lines[0], /outputCount=unrestricted_passthrough/)
})

test('logPrefixNarrowing handles null input without throwing', () => {
  const lines: string[] = []
  const log = (message: string) => lines.push(message)
  logPrefixNarrowing(log, 'skill', null, null, SKILL_TOOL_PREFIXES)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /inputCount=0/)
  assert.match(lines[0], /droppedSample=none/)
})
