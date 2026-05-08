#!/usr/bin/env node
/**
 * Stage R W1.4 — manifest vs asset directory parity gate.
 *
 * Asserts:
 *   manifest.ts EMBEDDED_SKILLS[*].id (set)
 *     === assets/embedded-skills/<id>/ subdirs (set)
 *
 * Either side missing an entry fails the gate.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    errors.push(`cannot read ${rel}: ${e.message}`)
    return ''
  }
}

const manifest = read('src/main/modules/skills-runtime/manifest.ts')
const manifestIds = new Set()
if (manifest) {
  // EMBEDDED_SKILLS array spans many lines; collect every `id: '<...>'`.
  const arrMatch = manifest.match(/EMBEDDED_SKILLS[^=]*=\s*\[([\s\S]*?)\n\]/)
  const body = arrMatch ? arrMatch[1] : ''
  const idRe = /\bid:\s*['"]([^'"]+)['"]/g
  let m
  while ((m = idRe.exec(body))) {
    manifestIds.add(m[1])
  }
  if (manifestIds.size === 0) {
    errors.push('manifest.ts: EMBEDDED_SKILLS appears empty or could not be parsed')
  }
}

const assetsDir = path.join(ROOT, 'assets/embedded-skills')
const assetIds = new Set()
if (fs.existsSync(assetsDir)) {
  for (const name of fs.readdirSync(assetsDir)) {
    const full = path.join(assetsDir, name)
    try {
      if (fs.statSync(full).isDirectory()) assetIds.add(name)
    } catch {
      // ignore
    }
  }
} else {
  errors.push('missing dir: assets/embedded-skills')
}

const inManifestNotAsset = [...manifestIds].filter((id) => !assetIds.has(id))
const inAssetNotManifest = [...assetIds].filter((id) => !manifestIds.has(id))
for (const id of inManifestNotAsset) {
  errors.push(`manifest declares '${id}' but assets/embedded-skills/${id}/ is missing`)
}
for (const id of inAssetNotManifest) {
  errors.push(`assets/embedded-skills/${id}/ exists but manifest does not declare it`)
}

if (errors.length > 0) {
  console.error('[check-embedded-skill-manifest-vs-asset-parity] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-embedded-skill-manifest-vs-asset-parity] OK')
