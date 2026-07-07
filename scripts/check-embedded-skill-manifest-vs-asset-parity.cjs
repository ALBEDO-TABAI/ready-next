#!/usr/bin/env node
/**
 * P2-3 (reversed) — every embedded skill directory is a self-describing, scannable skill.
 *
 * manifest.ts is no longer a hardcoded EMBEDDED_SKILLS union; it is a directory SCAN of
 * assets/embedded-skills/* (buildEmbeddedSkillManifests). So the old "manifest ids === asset
 * dirs" parity no longer applies. Instead we assert every subdir is registrable by the scan,
 * i.e. it carries an identity source that resolves to the DIRECTORY NAME:
 *
 *   - ready-skill.json present → JSON is the identity source; require valid JSON with
 *     `id` === directory name (that is the real embedded-skill identity contract).
 *   - else SKILL.md present → the frontmatter IS the identity; require frontmatter
 *     `name` === directory name AND a non-empty `description` (agentskills.io spec:
 *     name MUST match dir name for a bare SKILL.md skill).
 *   - neither → FAIL (the scan would silently skip this dir).
 *
 * Note (deliberate refinement of the plan's literal wording): for JSON-backed skills we do
 * NOT force the SKILL.md `name` to equal the dir name. Their identity comes from `json.id`
 * (which already equals the dir name for every current skill), and a few carry an intentional
 * short SKILL.md label (e.g. `vea` for video-expert-analyzer) or no name at all — blindly
 * rewriting those frontmatter names would be a non-surgical change with no identity benefit.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const ASSETS_DIR = path.join(ROOT, 'assets/embedded-skills')
const errors = []

function parseFrontmatterName(text) {
  const normalized = text.replace(/^﻿/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { name: '', description: '' }
  const meta = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (entry) meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { name: meta.name || '', description: meta.description || '' }
}

if (!fs.existsSync(ASSETS_DIR)) {
  console.error('[check-embedded-skill-manifest-vs-asset-parity] FAIL:')
  console.error('  - missing dir: assets/embedded-skills')
  process.exit(1)
}

for (const dirName of fs.readdirSync(ASSETS_DIR).sort()) {
  const dir = path.join(ASSETS_DIR, dirName)
  let isDir = false
  try {
    isDir = fs.statSync(dir).isDirectory()
  } catch {
    // ignore
  }
  if (!isDir) continue

  const jsonPath = path.join(dir, 'ready-skill.json')
  const skillMdPath = path.join(dir, 'SKILL.md')

  if (fs.existsSync(jsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      const id = typeof json.id === 'string' ? json.id.trim() : ''
      if (!id) {
        errors.push(`${dirName}/ready-skill.json: missing "id"`)
      } else if (id !== dirName) {
        errors.push(`${dirName}/ready-skill.json: id "${id}" must equal the directory name "${dirName}"`)
      }
      if (!(typeof json.description === 'string' && json.description.trim())) {
        errors.push(`${dirName}/ready-skill.json: missing non-empty "description"`)
      }
    } catch (e) {
      errors.push(`${dirName}/ready-skill.json: unparseable (${e.message})`)
    }
    continue
  }

  if (fs.existsSync(skillMdPath)) {
    const { name, description } = parseFrontmatterName(fs.readFileSync(skillMdPath, 'utf8'))
    if (!name) {
      errors.push(`${dirName}/SKILL.md: frontmatter missing "name" (required when there is no ready-skill.json)`)
    } else if (name !== dirName) {
      errors.push(`${dirName}/SKILL.md: frontmatter name "${name}" must equal the directory name "${dirName}"`)
    }
    if (!description) {
      errors.push(`${dirName}/SKILL.md: frontmatter missing "description"`)
    }
    continue
  }

  errors.push(`${dirName}/: no ready-skill.json or SKILL.md — the embedded scan would skip it`)
}

if (errors.length > 0) {
  console.error('[check-embedded-skill-manifest-vs-asset-parity] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-embedded-skill-manifest-vs-asset-parity] OK')
