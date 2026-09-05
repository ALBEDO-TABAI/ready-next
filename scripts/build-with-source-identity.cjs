'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { buildOutputManifest, buildSourceManifest } = require('./browser-live-proof-manifest.cjs')
const { BUILD_IDENTITY_REL, releaseSourceIdentity } = require('./release-package-identity.cjs')

function buildWithSourceIdentity(root, compile) {
  const identityPath = path.join(root, BUILD_IDENTITY_REL)
  fs.rmSync(identityPath, { force: true })
  const source = releaseSourceIdentity(root)
  fs.mkdirSync(path.dirname(identityPath), { recursive: true })
  fs.writeFileSync(path.join(root, 'build/browser-live-proof/source-manifest.json'),
    `${JSON.stringify(buildSourceManifest(root), null, 2)}\n`)
  const startedAt = new Date().toISOString()
  compile()
  if (!isDeepStrictEqual(source, releaseSourceIdentity(root))) {
    throw new Error('release source changed during compilation; rebuild from one stable source tree')
  }
  const identity = {
    contract: 'ready_release_build_v1', source, startedAt,
    completedAt: new Date().toISOString(), outputDigest: buildOutputManifest(root).digest,
  }
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`)
  return identity
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  buildWithSourceIdentity(root, () => {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: root, stdio: 'inherit', env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`compilation failed: ${result.status ?? result.signal}`)
  })
}

module.exports = { buildWithSourceIdentity }
