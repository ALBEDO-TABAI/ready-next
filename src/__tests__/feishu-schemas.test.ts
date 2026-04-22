/**
 * Shape tests for the feishu domain Zod schemas (Phase 2.5 PR 8).
 * Focused on required-field coverage + typing of record/array fields across
 * the four operation families (doc / message / calendar / chat / file).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FeishuDocReadSchema,
  FeishuDocCreateSchema,
  FeishuDocUpdateSchema,
  FeishuDocListSchema,
  FeishuMessageSendSchema,
  FeishuMessageGetContextSchema,
  FeishuMessageReplySchema,
  FeishuCalendarListEventsSchema,
  FeishuCalendarCreateEventSchema,
  FeishuCalendarUpdateEventSchema,
  FeishuCalendarDeleteEventSchema,
  FeishuChatListSchema,
  FeishuChatGetMembersSchema,
  FeishuChatGetInfoSchema,
  FeishuFileUploadSchema,
  FeishuFileDownloadSchema,
} from '../main/modules/tools/schemas/feishu-schemas'

test('doc schemas require core fields', () => {
  assert.equal(
    FeishuDocReadSchema.safeParse({ channel_id: 'c', doc_token: 't', doc_type: 'docx' }).success,
    true,
  )
  assert.equal(FeishuDocReadSchema.safeParse({}).success, false)
  assert.equal(
    FeishuDocCreateSchema.safeParse({ channel_id: 'c', title: 't', doc_type: 'doc' }).success,
    true,
  )
  assert.equal(
    FeishuDocUpdateSchema.safeParse({
      channel_id: 'c',
      doc_token: 't',
      doc_type: 'docx',
      updates: { ops: [] },
    }).success,
    true,
  )
  assert.equal(FeishuDocUpdateSchema.safeParse({ channel_id: 'c', updates: 'nope' }).success, false)
  assert.equal(FeishuDocListSchema.safeParse({ channel_id: 'c' }).success, true)
})

test('message schemas require recipient and content', () => {
  assert.equal(
    FeishuMessageSendSchema.safeParse({
      channel_id: 'c',
      chat_id: 'x',
      content: { text: 'hi' },
      msg_type: 'text',
    }).success,
    true,
  )
  assert.equal(
    FeishuMessageSendSchema.safeParse({ channel_id: 'c', chat_id: 'x', content: 'nope', msg_type: 'text' })
      .success,
    false,
  )
  assert.equal(
    FeishuMessageGetContextSchema.safeParse({ channel_id: 'c', chat_id: 'x' }).success,
    true,
  )
  assert.equal(
    FeishuMessageReplySchema.safeParse({
      channel_id: 'c',
      message_id: 'm',
      content: { text: 'hi' },
      msg_type: 'text',
    }).success,
    true,
  )
})

test('calendar schemas enforce required timing + attendees must be string[]', () => {
  assert.equal(
    FeishuCalendarListEventsSchema.safeParse({
      channel_id: 'c',
      start_time: '2026-04-22T00:00:00Z',
      end_time: '2026-04-23T00:00:00Z',
    }).success,
    true,
  )
  assert.equal(FeishuCalendarListEventsSchema.safeParse({ channel_id: 'c' }).success, false)
  const ok = FeishuCalendarCreateEventSchema.safeParse({
    channel_id: 'c',
    summary: 'S',
    start_time: 's',
    end_time: 'e',
    attendees: ['a@x', 'b@y'],
  })
  assert.equal(ok.success, true)
  assert.equal(
    FeishuCalendarCreateEventSchema.safeParse({
      channel_id: 'c',
      summary: 'S',
      start_time: 's',
      end_time: 'e',
      attendees: [1, 2],
    }).success,
    false,
  )
  assert.equal(
    FeishuCalendarUpdateEventSchema.safeParse({
      channel_id: 'c',
      event_id: 'e',
      updates: { summary: 'new' },
    }).success,
    true,
  )
  assert.equal(
    FeishuCalendarDeleteEventSchema.safeParse({ channel_id: 'c', event_id: 'e' }).success,
    true,
  )
})

test('chat schemas require channel_id + chat_id', () => {
  assert.equal(FeishuChatListSchema.safeParse({ channel_id: 'c' }).success, true)
  assert.equal(
    FeishuChatGetMembersSchema.safeParse({ channel_id: 'c', chat_id: 'x' }).success,
    true,
  )
  assert.equal(FeishuChatGetMembersSchema.safeParse({ channel_id: 'c' }).success, false)
  assert.equal(
    FeishuChatGetInfoSchema.safeParse({ channel_id: 'c', chat_id: 'x' }).success,
    true,
  )
})

test('file schemas require transport paths', () => {
  assert.equal(
    FeishuFileUploadSchema.safeParse({
      channel_id: 'c',
      file_path: '/tmp/a',
      file_type: 'image',
    }).success,
    true,
  )
  assert.equal(FeishuFileUploadSchema.safeParse({ channel_id: 'c', file_path: '/tmp/a' }).success, false)
  assert.equal(
    FeishuFileDownloadSchema.safeParse({
      channel_id: 'c',
      file_token: 'f',
      save_path: '/tmp/out',
    }).success,
    true,
  )
})
