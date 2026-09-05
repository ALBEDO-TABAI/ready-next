'use strict'

// electron-builder afterAllArtifactBuild hook.
//
// `build:dist` writes its DMG straight into exports/ and that is the artifact
// installed-acceptance runs against, so the source-identity receipt has to be
// produced here rather than only by the Packer server's copy step. Without it
// a DMG that passes acceptance cannot be tied back to the exact source tree it
// was built from.
const path = require('node:path')

const {
  writeReleasePackageReceipt,
} = require('./release-package-identity.cjs')

exports.default = function writeReleaseReceipts(buildResult, root = path.resolve(__dirname, '..')) {
  const artifacts = Array.isArray(buildResult?.artifactPaths) ? buildResult.artifactPaths : []
  const written = []
  for (const artifactPath of artifacts) {
    if (!artifactPath.toLowerCase().endsWith('.dmg')) continue
    written.push(writeReleasePackageReceipt(artifactPath, {
      root,
    }))
  }
  for (const receiptPath of written) {
    console.log(`📄 发布回执已输出：${path.relative(root, receiptPath)}`)
  }
  // Returning no extra files: the receipt sits beside the artifact and must not
  // be published as one.
  return []
}
