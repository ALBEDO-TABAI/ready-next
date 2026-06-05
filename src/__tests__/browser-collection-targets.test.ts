import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveCollectionTargets, targetsFromTask } from '../main/modules/browser-engine/collection-targets'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'

describe('browser collection target derivation', () => {
  it('keeps content-like links and filters shallow navigation entries generically', () => {
    const targets = deriveCollectionTargets([
      { sourceUrl: 'https://example.com/feed', title: 'Home', link: 'https://example.com/home' },
      { sourceUrl: 'https://example.com/feed', title: 'Search', link: 'https://example.com/search?q=a' },
      { sourceUrl: 'https://example.com/feed', title: 'First post', link: 'https://example.com/post/abc123?utm_source=x' },
      { sourceUrl: 'https://example.com/feed', title: 'Duplicate', link: 'https://example.com/post/abc123?utm_source=y' },
      { sourceUrl: 'https://example.com/feed', title: 'Second post', link: 'https://example.com/article/story-slug' },
      { sourceUrl: 'https://example.com/feed', title: 'Image asset', link: 'https://example.com/media/photo.webp' },
    ])

    assert.deepEqual(targets.map((target) => ({
      url: target.url,
      canonicalUrl: target.canonicalUrl,
      openUrl: target.openUrl,
      title: target.title,
      sourceId: target.sourceId,
      order: target.order,
      kind: target.kind,
    })), [
      {
        url: 'https://example.com/post/abc123',
        canonicalUrl: 'https://example.com/post/abc123',
        openUrl: 'https://example.com/post/abc123?utm_source=x',
        title: 'First post',
        sourceId: 'abc123',
        order: 3,
        kind: 'content',
      },
      {
        url: 'https://example.com/article/story-slug',
        canonicalUrl: 'https://example.com/article/story-slug',
        openUrl: 'https://example.com/article/story-slug',
        title: 'Second post',
        sourceId: 'story-slug',
        order: 5,
        kind: 'content',
      },
    ])
  })

  it('recovers frozen targets from task results or checkpoints', () => {
    const fromResult = targetsFromTask({
      taskId: 'browser-task-1',
      kind: 'visible_collect',
      status: 'cancelled',
      progress: { total: 1, completed: 1, failed: 0 },
      result: { noteCandidates: [{ url: 'https://example.com/post/a', title: 'A', sourceId: 'a' }] },
    } as BrowserCapabilityTaskHandle)
    assert.deepEqual(fromResult.map((target) => ({ url: target.url, openUrl: target.openUrl, title: target.title, sourceId: target.sourceId })), [
      { url: 'https://example.com/post/a', openUrl: 'https://example.com/post/a', title: 'A', sourceId: 'a' },
    ])

    const fromCheckpoint = targetsFromTask({
      taskId: 'browser-task-2',
      kind: 'visible_collect',
      status: 'cancelled',
      progress: { total: 1, completed: 1, failed: 0 },
      checkpoint: {
        taskId: 'browser-task-2',
        stage: 'visible_collect_round',
        partialResults: [{ sourceUrl: 'https://example.com/feed', title: 'B', link: 'https://example.com/post/b' }],
      },
    } as BrowserCapabilityTaskHandle)
    assert.deepEqual(fromCheckpoint.map((target) => ({ url: target.url, openUrl: target.openUrl, title: target.title, sourceId: target.sourceId })), [
      { url: 'https://example.com/post/b', openUrl: 'https://example.com/post/b', title: 'B', sourceId: 'b' },
    ])
  })
})
