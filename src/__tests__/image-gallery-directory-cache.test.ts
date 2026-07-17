import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createImageGalleryRequestGate,
  getImageGalleryDirectory,
  getImageGalleryDirectoryCacheStatsForTests,
  invalidateImageGalleryDirectories,
  loadImageGalleryDirectory,
  resetImageGalleryDirectoryCacheForTests,
  subscribeImageGalleryDirectory,
} from '../renderer/modules/document/imageGalleryDirectoryCache'

test('image gallery ignores an invalidated directory request that resolves after its replacement', async () => {
  const gate = createImageGalleryRequestGate()
  let releaseOlder!: (items: string[]) => void
  let releaseNewer!: (items: string[]) => void
  const older = new Promise<string[]>((resolve) => { releaseOlder = resolve })
  const newer = new Promise<string[]>((resolve) => { releaseNewer = resolve })
  const applied: string[][] = []
  const olderGeneration = gate.begin()
  const olderApply = older.then((items) => {
    if (gate.isCurrent(olderGeneration)) applied.push(items)
  })
  const newerGeneration = gate.begin()
  const newerApply = newer.then((items) => {
    if (gate.isCurrent(newerGeneration)) applied.push(items)
  })

  releaseNewer(['newer'])
  await newerApply
  releaseOlder(['older'])
  await olderApply

  assert.deepEqual(applied, [['newer']])
})

test('image gallery preserves Windows drive roots when deriving directories', () => {
  assert.equal(getImageGalleryDirectory('C:\\photo.png'), 'C:/')
  assert.equal(getImageGalleryDirectory('C:\\Pictures\\photo.png'), 'C:/Pictures')
})

test('image gallery lists a directory once until that exact directory changes', async () => {
  resetImageGalleryDirectoryCacheForTests()
  let calls = 0
  let invalidations = 0
  const list = async () => {
    calls += 1
    return {
      success: true,
      items: [
        { name: '2.png', path: '/photos/2.png', isDirectory: false },
        { name: '1.jpg', path: '/photos/1.jpg', isDirectory: false },
        { name: 'note.md', path: '/photos/note.md', isDirectory: false },
      ],
    }
  }
  const unsubscribe = subscribeImageGalleryDirectory('/photos', () => { invalidations += 1 })

  for (let index = 0; index < 20; index += 1) {
    const siblings = await loadImageGalleryDirectory('/photos', list)
    assert.deepEqual(siblings.map((item) => item.alt), ['1.jpg', '2.png'])
  }
  assert.equal(calls, 1)
  assert.deepEqual(getImageGalleryDirectoryCacheStatsForTests(), { size: 1, listRequests: 1 })

  assert.equal(invalidateImageGalleryDirectories(['/other']), 0)
  assert.equal(invalidations, 0)
  assert.equal(invalidateImageGalleryDirectories(['/photos']), 1)
  assert.equal(invalidations, 1)

  await loadImageGalleryDirectory('/photos', list)
  assert.equal(calls, 2)
  unsubscribe()
  resetImageGalleryDirectoryCacheForTests()
})
