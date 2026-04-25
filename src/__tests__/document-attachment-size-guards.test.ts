import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ATTACHMENT_HARD_CAP_BYTES,
  IMAGE_INLINE_CAP_BYTES,
  VIDEO_INLINE_CAP_BYTES,
  base64DecodedLength,
  categoryFromSuggestedName,
  decideAttachmentSize,
  decideReadAttachmentSize,
} from '../main/modules/document-engine/attachment-size-guards'

const MB = 1024 * 1024

describe('document attachment size guards', () => {
  describe('cap constants', () => {
    it('uses the documented thresholds', () => {
      assert.equal(ATTACHMENT_HARD_CAP_BYTES, 100 * MB)
      assert.equal(VIDEO_INLINE_CAP_BYTES, 40 * MB)
      assert.equal(IMAGE_INLINE_CAP_BYTES, 20 * MB)
    })
  })

  describe('base64DecodedLength', () => {
    it('returns 0 for an empty value', () => {
      assert.equal(base64DecodedLength(''), 0)
    })

    it('handles an unpadded base64 body', () => {
      // Buffer.from('abc').toString('base64') === 'YWJj'
      assert.equal(base64DecodedLength('YWJj'), 3)
    })

    it('handles single-pad and double-pad correctly', () => {
      // 'ab' → 'YWI=' (1 pad, 2 bytes); 'a' → 'YQ==' (2 pads, 1 byte)
      assert.equal(base64DecodedLength('YWI='), 2)
      assert.equal(base64DecodedLength('YQ=='), 1)
    })

    it('strips data URL prefix before measuring', () => {
      assert.equal(base64DecodedLength('data:image/png;base64,YWJj'), 3)
    })
  })

  describe('categoryFromSuggestedName', () => {
    it('maps common extensions to categories', () => {
      assert.equal(categoryFromSuggestedName('clip.mp4'), 'video')
      assert.equal(categoryFromSuggestedName('photo.jpg'), 'image')
      assert.equal(categoryFromSuggestedName('handout.pdf'), 'pdf')
      assert.equal(categoryFromSuggestedName('beep.mp3'), 'audio')
      assert.equal(categoryFromSuggestedName('scratch.bin'), 'binary')
    })

    it('returns binary for missing names', () => {
      assert.equal(categoryFromSuggestedName(undefined), 'binary')
      assert.equal(categoryFromSuggestedName(null), 'binary')
      assert.equal(categoryFromSuggestedName(''), 'binary')
    })
  })

  describe('decideAttachmentSize (saveAs base64 guard)', () => {
    it('accepts a 5 MB image base64 payload', () => {
      const decision = decideAttachmentSize(5 * MB, 'image')
      assert.deepEqual(decision, { kind: 'ok' })
    })

    it('refuses a 30 MB image base64 payload', () => {
      const decision = decideAttachmentSize(30 * MB, 'image')
      assert.equal(decision.kind, 'image_too_large_for_base64')
      if (decision.kind === 'image_too_large_for_base64') {
        assert.equal(decision.max, IMAGE_INLINE_CAP_BYTES)
        assert.equal(decision.actual, 30 * MB)
      }
    })

    it('refuses a 50 MB video base64 payload', () => {
      const decision = decideAttachmentSize(50 * MB, 'video')
      assert.equal(decision.kind, 'video_too_large_for_base64')
      if (decision.kind === 'video_too_large_for_base64') {
        assert.equal(decision.max, VIDEO_INLINE_CAP_BYTES)
        assert.equal(decision.actual, 50 * MB)
      }
    })

    it('refuses any 150 MB payload via the absolute cap', () => {
      const decision = decideAttachmentSize(150 * MB, 'binary')
      assert.equal(decision.kind, 'attachment_too_large')
      if (decision.kind === 'attachment_too_large') {
        assert.equal(decision.max, ATTACHMENT_HARD_CAP_BYTES)
        assert.equal(decision.actual, 150 * MB)
      }
    })

    it('treats 20 MB image (== cap) as ok and 20 MB + 1 as too large', () => {
      assert.deepEqual(decideAttachmentSize(IMAGE_INLINE_CAP_BYTES, 'image'), { kind: 'ok' })
      const over = decideAttachmentSize(IMAGE_INLINE_CAP_BYTES + 1, 'image')
      assert.equal(over.kind, 'image_too_large_for_base64')
    })

    it('treats 40 MB video (== cap) as ok and 40 MB + 1 as too large', () => {
      assert.deepEqual(decideAttachmentSize(VIDEO_INLINE_CAP_BYTES, 'video'), { kind: 'ok' })
      const over = decideAttachmentSize(VIDEO_INLINE_CAP_BYTES + 1, 'video')
      assert.equal(over.kind, 'video_too_large_for_base64')
    })

    it('does not apply the image cap to non-image categories', () => {
      // 30 MB audio is well under the 100 MB hard cap, no per-category guard.
      const decision = decideAttachmentSize(30 * MB, 'audio')
      assert.deepEqual(decision, { kind: 'ok' })
    })
  })

  describe('decideReadAttachmentSize (document:read guard)', () => {
    it('returns large_video_ref for a 50 MB video file on disk', () => {
      const decision = decideReadAttachmentSize(50 * MB, 'video')
      assert.equal(decision.kind, 'large_video_ref')
      if (decision.kind === 'large_video_ref') {
        assert.equal(decision.size, 50 * MB)
      }
    })

    it('returns large_image_ref for a 30 MB image on disk', () => {
      const decision = decideReadAttachmentSize(30 * MB, 'image')
      assert.equal(decision.kind, 'large_image_ref')
      if (decision.kind === 'large_image_ref') {
        assert.equal(decision.size, 30 * MB)
      }
    })

    it('returns ok+loadInlineBytes:false for a small video (renderer streams via localUrl)', () => {
      const decision = decideReadAttachmentSize(5 * MB, 'video')
      assert.equal(decision.kind, 'ok')
      if (decision.kind === 'ok') {
        assert.equal(decision.loadInlineBytes, false)
      }
    })

    it('returns ok+loadInlineBytes:true for a small PDF (preview path)', () => {
      const decision = decideReadAttachmentSize(2 * MB, 'pdf')
      assert.equal(decision.kind, 'ok')
      if (decision.kind === 'ok') {
        assert.equal(decision.loadInlineBytes, true)
      }
    })

    it('refuses inline bytes for a 50 MB PDF (reader must stream via localUrl)', () => {
      const decision = decideReadAttachmentSize(50 * MB, 'pdf')
      assert.equal(decision.kind, 'pdf_too_large_for_inline_bytes')
      if (decision.kind === 'pdf_too_large_for_inline_bytes') {
        assert.equal(decision.max, VIDEO_INLINE_CAP_BYTES)
        assert.equal(decision.actual, 50 * MB)
      }
    })

    it('hits the hard cap before any per-category branch (150 MB video)', () => {
      const decision = decideReadAttachmentSize(150 * MB, 'video')
      assert.equal(decision.kind, 'attachment_too_large')
      if (decision.kind === 'attachment_too_large') {
        assert.equal(decision.max, ATTACHMENT_HARD_CAP_BYTES)
        assert.equal(decision.actual, 150 * MB)
      }
    })
  })
})
