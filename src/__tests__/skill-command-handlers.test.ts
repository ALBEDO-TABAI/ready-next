import { describe, it } from 'node:test'
import assert from 'node:assert'

import { extractSkillCommandFromText } from '../renderer/modules/agent/commandHandlers'

describe('skill command extraction', () => {
  it('extracts inline skill commands from assistant prose', () => {
    const command = extractSkillCommandFromText([
      '我来调用 Video Copy Analyzer 分析这个视频。',
      '',
      '执行分析: /skill video-copy-analyzer analyze {"video_path":"ms://demo","output_path":"/tmp/out"}',
    ].join('\n'))

    assert.strictEqual(
      command,
      '/skill video-copy-analyzer analyze {"video_path":"ms://demo","output_path":"/tmp/out"}',
    )
  })

  it('returns null when no skill command exists', () => {
    assert.strictEqual(extractSkillCommandFromText('我会先读取页面再继续。'), null)
  })
})
