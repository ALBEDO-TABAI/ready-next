'use strict'

// electron-builder afterAllArtifactBuild hook.
//
// `build:dist` writes its DMG straight into exports/ and that is the artifact
// installed-acceptance runs against, so the source-identity receipt has to be
// produced here rather than only by the Packer server's copy step. Without it
// a DMG that passes acceptance cannot be tied back to the exact source tree it
// was built from.
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function writeReleaseReceipts(buildResult, root = path.resolve(__dirname, '..')) {
  const artifacts = Array.isArray(buildResult?.artifactPaths) ? buildResult.artifactPaths : []
  const dmgs = artifacts.filter(file => file.toLowerCase().endsWith('.dmg'))
  if (dmgs.length === 0) return []
  const { writeReleasePackageReceipt } = require('./release-package-identity.cjs')
  const written = []
  const { inspectBookSourceBuild } = await import('./verify-ready-next-book-sources.mjs')
  for (const artifactPath of dmgs) {
    const features = inspectBookSourceBuild(path.join(root, 'out'))
    const receiptPath = writeReleasePackageReceipt(artifactPath, { root })
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    receipt.buildFeatures = { ctfile: features.ctfile }
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    written.push(receiptPath)
  }
  for (const receiptPath of written) {
    console.log(`📄 发布回执已输出：${path.relative(root, receiptPath)}`)
  }
  // Returning no extra files: the receipt sits beside the artifact and must not
  // be published as one.
  return []
}
