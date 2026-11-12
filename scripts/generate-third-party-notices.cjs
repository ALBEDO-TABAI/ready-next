#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LICENSE_FILE = /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i

function readText(root, file) {
  return { path: file.split(path.sep).join('/'), content: fs.readFileSync(path.resolve(root, file), 'utf8') }
}

function generate({ root = path.resolve(__dirname, '..'), runNpm = spawnSync } = {}) {
  const result = runNpm(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ls', '--omit=dev', '--all', '--json', '--long'], {
      cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_logs_max: '0' },
    })
  if (result.error) throw result.error
  const tree = JSON.parse(result.stdout)
  // npm reports invalid peer/dependency markers with exit 1 but still emits the complete tree.
  if (result.status !== 0 && !(result.status === 1 && tree.error?.code === 'ELSPROBLEMS')) {
    throw new Error(`npm ls failed (${result.status}): ${result.stderr}`)
  }
  if (!tree.dependencies || typeof tree.dependencies !== 'object') throw new Error('npm ls returned no dependency tree')
  if (result.status === 1) console.warn(`npm ls: ${tree.problems?.join('; ') || tree.error.summary}`)
  const packages = new Map()
  const seenPaths = new Set()
  function visit(node) {
    if (node.path && !seenPaths.has(node.path)) {
      seenPaths.add(node.path)
      const dir = path.resolve(root, node.path)
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (!pkg.name || !pkg.version) throw new Error(`Package identity missing: ${dir}`)
      const key = `${pkg.name}@${pkg.version}`
      const rawLicense = pkg.license ?? pkg.licenses
      const license = typeof rawLicense === 'string' ? rawLicense
        : Array.isArray(rawLicense) ? rawLicense.map(item => typeof item === 'string' ? item : item.type).join(', ')
          : rawLicense?.type ?? null
      const entry = packages.get(key) || {
        name: pkg.name, version: pkg.version, license,
        repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null,
        texts: [], notes: [], textMissing: true, kind: 'npm',
      }
      if (rawLicense && typeof rawLicense !== 'string') {
        const note = `Original license metadata: ${JSON.stringify(rawLicense)}`
        if (!entry.notes.includes(note)) entry.notes.push(note)
      }
      for (const file of fs.readdirSync(dir).sort()) {
        if (!LICENSE_FILE.test(file) || !fs.statSync(path.join(dir, file)).isFile()) continue
        const text = readText(root, path.relative(root, path.join(dir, file)))
        // Identical installed copies do not repeat text; distinct notices are retained.
        if (!entry.texts.some(item => path.basename(item.path) === file && item.content === text.content)) entry.texts.push(text)
      }
      entry.textMissing = !entry.texts.some(text => text.content.trim())
      packages.set(key, entry)
    }
    for (const child of Object.values(node.dependencies || {})) visit(child)
  }
  for (const node of Object.values(tree.dependencies)) visit(node)
  const manual = JSON.parse(fs.readFileSync(path.join(root, 'licenses/ready-next/manifest.json'), 'utf8'))
  const entries = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
  for (const item of manual) {
    const texts = []
    const notes = [...item.notes]
    let missing = item.textMissing === true
    for (const file of item.textFiles) {
      try {
        texts.push(readText(root, file))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        missing = true
        notes.push(`Missing file: ${file}`)
      }
    }
    entries.push({ name: item.name, version: item.version, license: item.license, repository: item.repository,
      texts, notes, textMissing: missing || !texts.some(text => text.content.trim()), kind: 'manual' })
  }
  const output = path.join(root, 'licenses/generated')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'third-party-notices.json'), JSON.stringify(entries, null, 2) + '\n')
  const heading = 'Ready Next — Third-party notices\nInstalled production npm tree + manual declarations; not a determination of final bundle contents or licensing clearance.\n'
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), heading + entries.map(entry => [
    '\n' + '='.repeat(72), `${entry.name}@${entry.version ?? 'unknown'} [${entry.kind}]`,
    `License: ${entry.license ?? 'not declared'}`, `Repository: ${entry.repository ?? 'not recorded'}`,
    `textMissing: ${entry.textMissing}`, ...entry.notes,
    ...entry.texts.map(text => `\n--- ${text.path} ---\n${text.content}`),
  ].join('\n')).join('\n') + '\n')
  return entries
}

if (require.main === module) {
  const entries = generate()
  const licenses = {}
  for (const entry of entries) licenses[entry.license ?? '(not declared)'] = (licenses[entry.license ?? '(not declared)'] || 0) + 1
  console.log(JSON.stringify({ total: entries.length, npm: entries.filter(e => e.kind === 'npm').length,
    manual: entries.filter(e => e.kind === 'manual').length, textMissing: entries.filter(e => e.textMissing).length, licenses }, null, 2))
}
module.exports = { generate }
