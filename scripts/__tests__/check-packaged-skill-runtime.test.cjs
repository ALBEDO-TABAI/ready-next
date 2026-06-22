'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  verifyDarwinAppBundleStructure,
  verifyPackagedApp,
  verifyPackagedSkillRuntime,
} = require('../check-packaged-skill-runtime.cjs')

function makeAppFixture(t, withRuntime = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-packaged-runtime-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appPath = path.join(root, 'Ready.app')
  const resources = path.join(appPath, 'Contents', 'Resources')
  const macos = path.join(appPath, 'Contents', 'MacOS')
  const framework = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
  )
  fs.mkdirSync(macos, { recursive: true })
  fs.mkdirSync(framework, { recursive: true })
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(macos, 'Ready'), '#!/bin/sh\n', 'utf8')
  fs.symlinkSync('A', path.join(path.dirname(framework), 'Current'))
  fs.writeFileSync(path.join(framework, 'Electron Framework'), '#!/bin/sh\n', 'utf8')
  if (!withRuntime) return appPath

  const runtime = path.join(resources, 'skill-runtime')
  fs.mkdirSync(path.join(runtime, 'python', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({
    runtimeId: 'test-runtime',
    embeddedSkillIds: ['video-expert-analyzer', 'video-copy-analyzer'],
    tools: ['yt-dlp', 'ffmpeg', 'ffprobe'],
  }), 'utf8')
  for (const rel of ['python/bin/python3', 'bin/yt-dlp', 'bin/ffmpeg', 'bin/ffprobe']) {
    fs.writeFileSync(path.join(runtime, rel), '#!/bin/sh\n', 'utf8')
  }
  return appPath
}

test('packaged runtime check accepts a release app with VEA toolchain', (t) => {
  const appPath = makeAppFixture(t, true)
  const result = verifyPackagedSkillRuntime(appPath)
  assert.equal(result.runtimeId, 'test-runtime')
  assert.match(result.runtimeRoot, /skill-runtime$/)
})

test('packaged app check rejects missing Electron Framework binary', (t) => {
  const appPath = makeAppFixture(t, true)
  fs.rmSync(path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework',
  ))
  assert.throws(
    () => verifyDarwinAppBundleStructure(appPath),
    /missing Electron Framework binary/,
  )
})

test('packaged app check combines bundle and runtime validation', (t) => {
  const appPath = makeAppFixture(t, true)
  const result = verifyPackagedApp(appPath, { verifySignature: false })
  assert.equal(result.runtime.runtimeId, 'test-runtime')
  assert.match(result.bundle.framework, /Electron Framework$/)
})

test('packaged runtime check rejects apps without skill-runtime', (t) => {
  const appPath = makeAppFixture(t, false)
  assert.throws(
    () => verifyPackagedSkillRuntime(appPath),
    /packaged skill-runtime not found/,
  )
})

test('seeded dist build uses the runtime-aware seeded packager', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
  assert.match(pkg.scripts['build:dist:seeded'], /build-seeded-dist\.mjs/)
})

test('seeded packager requires and verifies packaged skill-runtime', () => {
  const script = fs.readFileSync(path.resolve(process.cwd(), 'scripts/build-seeded-dist.mjs'), 'utf8')
  assert.match(script, /READY_RELEASE_SKILL_RUNTIME_ROOT is required/)
  assert.match(script, /to: 'skill-runtime'/)
  assert.match(script, /check-packaged-skill-runtime\.cjs.+--app/s)
  assert.match(script, /check-packaged-skill-runtime\.cjs.+--dmg/s)
  assert.match(script, /hdiutil.+verify/s)
  assert.match(script, /target: 'dir'/)
})
