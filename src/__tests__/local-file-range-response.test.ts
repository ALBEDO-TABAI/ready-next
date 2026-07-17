import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  createLocalFileResponse,
  parseSingleByteRange,
} from '../main/modules/app-control/local-file-response'

function localFileUrl(path: string): string {
  return pathToFileURL(path).href.replace(/^file:/, 'local-file:')
}

test('local-file response supports HEAD and bounded byte ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-local-range-'))
  try {
    const path = join(directory, 'sample.pdf')
    const url = localFileUrl(path)
    await writeFile(path, '0123456789')
    const options = { isPathAllowed: () => true }

    const head = await createLocalFileResponse(new Request(url, { method: 'HEAD' }), options)
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('Content-Length'), '10')
    assert.equal(head.headers.get('Accept-Ranges'), 'bytes')
    assert.equal(await head.text(), '')

    const partial = await createLocalFileResponse(new Request(url, {
      headers: { Range: 'bytes=2-5' },
    }), options)
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('Content-Range'), 'bytes 2-5/10')
    assert.equal(await partial.text(), '2345')

    const suffix = await createLocalFileResponse(new Request(url, {
      headers: { Range: 'bytes=-3' },
    }), options)
    assert.equal(suffix.status, 206)
    assert.equal(await suffix.text(), '789')

    const invalid = await createLocalFileResponse(new Request(url, {
      headers: { Range: 'bytes=20-30' },
    }), options)
    assert.equal(invalid.status, 416)
    assert.equal(invalid.headers.get('Content-Range'), 'bytes */10')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('local-file range parser clamps ends and rejects malformed or multiple ranges', () => {
  assert.deepEqual(parseSingleByteRange('bytes=7-', 10), { kind: 'range', start: 7, end: 9 })
  assert.deepEqual(parseSingleByteRange('bytes=7-99', 10), { kind: 'range', start: 7, end: 9 })
  assert.deepEqual(parseSingleByteRange('bytes=1-2,4-5', 10), { kind: 'unsatisfiable' })
  assert.deepEqual(parseSingleByteRange('items=1-2', 10), { kind: 'unsatisfiable' })
})
