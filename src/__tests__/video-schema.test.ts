import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildRenderTimelineRequest,
  buildVideoProjectSchema,
  hashVideoTimeline,
} from '../renderer/modules/video/schema'
import type { TimelineClip } from '../renderer/modules/video/types'

const videoClip: TimelineClip = {
  id: 'video-1',
  type: 'video',
  start: 0,
  end: 12,
  label: 'intro',
  color: '#5B8DEF',
  source: '/tmp/video.mp4',
}

describe('video schema helpers', () => {
  it('builds a stable project schema with summary and primary source', () => {
    const schema = buildVideoProjectSchema({
      projectId: 'video-project-main',
      selectedFile: null,
      videoClips: [videoClip],
      subtitleClips: [],
      audioClips: [],
      duration: 12,
      currentTime: 3.5,
      isPlaying: true,
      zoom: 1.25,
    })

    assert.strictEqual(schema.schemaVersion, 1)
    assert.strictEqual(schema.primarySourcePath, '/tmp/video.mp4')
    assert.strictEqual(schema.timeline.summary.videoClips, 1)
    assert.strictEqual(schema.timeline.summary.duration, 12)
    assert.strictEqual(schema.previewState.isPlaying, true)
    assert.strictEqual(schema.timeline.hash, hashVideoTimeline({
      tracks: schema.timeline.tracks,
      summary: schema.timeline.summary,
      width: schema.composition.width,
      height: schema.composition.height,
      fps: schema.composition.fps,
    }))
  })

  it('builds render requests directly from the schema composition', () => {
    const schema = buildVideoProjectSchema({
      projectId: 'video-project-main',
      selectedFile: '/tmp/video.mp4',
      videoClips: [videoClip],
      subtitleClips: [],
      audioClips: [],
      duration: 12,
      currentTime: 0,
      isPlaying: false,
      zoom: 1,
      fps: 24,
      width: 720,
      height: 1280,
    })

    const request = buildRenderTimelineRequest(schema, '/tmp/output.mp4')

    assert.deepStrictEqual(request, {
      output: '/tmp/output.mp4',
      width: 720,
      height: 1280,
      fps: 24,
      duration: 12,
      tracks: {
        video: [videoClip],
        subtitle: [],
        audio: [],
      },
    })
  })
})
