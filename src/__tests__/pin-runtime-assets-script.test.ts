import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scriptPath = fileURLToPath(new URL('../../scripts/pin-runtime-assets.mjs', import.meta.url))

test('pin-runtime-assets script pins a local archive and verifies output layout', () => {
  const work = mkdtempSync(join(tmpdir(), `ready-pin-script-test-${process.pid}-`))
  try {
    const payloadRoot = join(work, 'payload')
    const pythonDir = join(payloadRoot, 'python', 'bin')
    mkdirSync(pythonDir, { recursive: true })
    const outputBytes = Buffer.from('#!/bin/sh\nprintf fixture-python\n', 'utf8')
    writeFileSync(join(pythonDir, 'python3'), outputBytes)

    const archivePath = join(work, 'cpython-fixture.tar.gz')
    execFileSync('tar', ['-czf', archivePath, '-C', payloadRoot, 'python'])
    const expectedOutputSha = createHash('sha256').update(outputBytes).digest('hex')
    const expectedArchiveSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex')

    const manifestPath = join(work, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify([{
      platform: 'darwin-arm64',
      id: 'python',
      archives: [{
        filename: 'cpython-fixture.tar.gz',
        archiveKind: 'tar.gz',
        sources: [
          pathToFileURL(join(work, 'missing.tar.gz')).href,
          pathToFileURL(archivePath).href,
        ],
        outputs: [{ kind: 'python', relPath: 'python/bin/python3', expectedSha256: expectedOutputSha }],
      }],
    }], null, 2))

    const outPath = join(work, 'pins.json')
    execFileSync(process.execPath, [scriptPath, '--manifest', manifestPath, '--out', outPath], {
      cwd: projectRoot,
      stdio: 'pipe',
    })

    const pins = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.equal(pins.length, 1)
    assert.equal(pins[0].platform, 'darwin-arm64')
    assert.equal(pins[0].id, 'python')
    assert.equal(pins[0].filename, 'cpython-fixture.tar.gz')
    assert.equal(pins[0].sha256, expectedArchiveSha)
    assert.equal(pins[0].layoutOk, true)
    assert.deepEqual(pins[0].missing, [])
    assert.deepEqual(pins[0].badSha, [])
    assert.equal(pins[0].outputs[0].actualSha256, expectedOutputSha)
    assert.equal(pins[0].outputs[0].shaOk, true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
