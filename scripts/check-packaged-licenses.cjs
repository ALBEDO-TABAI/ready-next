#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

function checkPackagedLicenses(input) {
  const root = path.resolve(input)
  const candidates = [path.join(root, 'Contents/Resources'), path.join(root, 'resources'), root]
  if (fs.existsSync(root)) {
    for (const file of fs.readdirSync(root)) {
      if (file.endsWith('.app')) candidates.push(path.join(root, file, 'Contents/Resources'))
    }
  }
  const resources = candidates.find(dir => fs.existsSync(path.join(dir, 'licenses/generated/third-party-notices.json')))
  assert.ok(resources, `Missing licenses/generated/third-party-notices.json under ${root}`)
  const required = [
    'licenses/generated/third-party-notices.json', 'licenses/generated/THIRD_PARTY_NOTICES.txt',
    'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html',
    ...['Inter', 'InterTight', 'InstrumentSerif', 'GeistMono'].map(name => `licenses/ready-next/OFL-${name}.txt`),
    'licenses/ready-next/paper-flipbook-LICENSE.txt', 'licenses/ready-next/lets-go-rss-NOTICE.txt',
    'app.asar.unpacked/node_modules/rsshub/LICENSE',
  ]
  for (const file of required) {
    const fullPath = path.join(resources, file)
    assert.ok(fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && fs.statSync(fullPath).size > 0, `Missing/empty: ${file}`)
  }
  const entries = JSON.parse(fs.readFileSync(path.join(resources, required[0]), 'utf8'))
  assert.ok(Array.isArray(entries) && entries.length > 0, 'Empty or invalid notices')
  assert.ok(entries.some(e => e.kind === 'npm' && e.name === 'rsshub' && e.texts.some(t => t.content.trim())), 'Missing RSSHub notice text')
  // Packaging drops dependencies' Markdown files, LICENSE.md included: their texts must be in the notices instead.
  for (const name of ['@mozilla/readability', 'date-fns']) {
    assert.ok(entries.some(e => e.kind === 'npm' && e.name === name && e.texts.some(t => /\.md$/i.test(t.path) && t.content.trim())), `Missing ${name} LICENSE.md text in the notices`)
  }
  return resources
}
if (require.main === module) {
  assert.ok(process.argv[2], 'Usage: node scripts/check-packaged-licenses.cjs <.app or unpacked directory>')
  console.log(`Packaged licenses OK: ${checkPackagedLicenses(process.argv[2])}`)
}
module.exports = { checkPackagedLicenses }
