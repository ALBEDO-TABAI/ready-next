import assert from 'node:assert/strict'
import test from 'node:test'

import { isPathAllowed } from '../main/modules/app-control/local-path-safety'

test('local path safety rejects sensitive credential locations', () => {
  const sensitive = [
    '/Users/alice/.ssh/id_rsa',
    '/Users/alice/.aws/credentials',
    '/Users/alice/project/.env',
    '/Users/alice/.npmrc',
    '/Users/alice/.gitconfig',
  ]

  for (const path of sensitive) {
    assert.equal(isPathAllowed(path), false, path)
  }
})

test('local path safety allows ordinary project files', () => {
  assert.equal(isPathAllowed('/Users/alice/Documents/project/reference.readyboard'), true)
  assert.equal(isPathAllowed('/Users/alice/Documents/project/assets/image.png'), true)
})

test('local path safety rejects empty inputs', () => {
  assert.equal(isPathAllowed(''), false)
})
