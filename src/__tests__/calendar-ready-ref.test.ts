import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarEventReadyRef, calendarEventReferenceId } from '../shared/calendar-event-identity'
import { parseReadyUri, toReadyUri } from '../shared/ready-ref'
import { createReadyContextAttachment } from '../renderer/modules/agent/chat-input-bridge'
import { buildCodexIngressInputWithDiagnostics, extractAttachmentsFromMeta } from '../renderer/modules/agent/messageComposer'

for (const [id, allDay, occurrence] of [
  ['event', false, undefined], ['day', true, undefined],
  ['series#1793318400', false, '1793318400000'],
  ['series#1793318400', true, '2026-10-30'],
] as const) {
  test(`C1 calendar attachment and ingress preserve ${id} / allDay=${allDay}`, async () => {
    const expected = { kind: 'event', id: id.split('#')[0], ...(occurrence ? { occurrence } : {}) }
    const ref = calendarEventReadyRef(id, allDay)
    assert.deepEqual(ref, expected)
    assert.deepEqual(parseReadyUri(toReadyUri(ref!)), { ok: true, ref: expected })
    assert.equal(calendarEventReferenceId(ref!), id)
    const attachment = await createReadyContextAttachment({ type: 'calendar-event', name: 'Meeting', eventId: id, allDay })
    assert.ok(attachment)
    assert.equal(attachment.path, toReadyUri(ref!))
    const result = await buildCodexIngressInputWithDiagnostics({ content: 'Read it', attachments: [attachment] })
    assert.deepEqual(result.resources, [{ kind: 'calendar_event', id: attachment.id, name: 'Meeting', eventId: id }])
  })
}

test('C1 missing identity is visibly unlocatable, survives history, and cannot grant a resource', async () => {
  const attachment = await createReadyContextAttachment({ type: 'calendar-event', name: 'Placeholder' })
  assert.ok(attachment)
  assert.equal(attachment.path, '')
  assert.match(attachment.name, /无法定位/)
  assert.match(attachment.description!, /缺少/)
  const restored = extractAttachmentsFromMeta({ attachments: [attachment] })!
  assert.equal(restored.length, 1)
  const input = await buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: restored })
  assert.equal(input.resources?.length, 0)
  assert.equal(input.diagnostics.inputFailedCount, 1)
})

test('C1 malformed or ambiguous instances never degrade to the series', () => {
  assert.equal(calendarEventReadyRef('series#1793318400'), null)
  assert.equal(calendarEventReadyRef('series#nan', false), null)
  assert.equal(calendarEventReadyRef('series#9007199254740', false), null)
  assert.equal(calendarEventReadyRef('series#123', true), null)
  assert.throws(() => calendarEventReferenceId({ kind: 'event', id: 'series', occurrence: 'nan' }))
})

// allow-source-grep: this is the C1 structural retirement boundary, not a behavior test;
// the tests above and the native suite separately prove conversion, ingress and migration.
test('C1 old calendar URI syntax is confined to its migration, never a runtime fallback', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inspect(path)
      else if (/\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('calendar-engine/ready-ref-migration.ts')) {
        assert.equal((await readFile(path, 'utf8')).includes('calendar-event://'), false, path)
      }
    }
  }
  for (const directory of ['src/main', 'src/renderer', 'src/shared']) await inspect(directory)
})
