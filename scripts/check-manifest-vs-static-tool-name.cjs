#!/usr/bin/env node
/**
 * Stage N — manifest ⇔ static-name registry consistency gate (Phase 0.2).
 *
 * Invariant N2b: every action listed in an embedded skill's
 * `child_loop.actions[]` MUST appear as a `<skillId>:<action>` key in the
 * forward literal `STATIC_SKILL_TOOL_NAMES_BY_ACTION`
 * (`src/main/modules/tools/skills-tools-static.ts:27`). Reverse: every entry
 * in that table whose `<skillId>` matches an embedded manifest with
 * `child_loop.actions[]` MUST have its `<action>` listed there.
 *
 * Why both directions: forward catches manifests adding new long-skill
 * actions without registering tool names; reverse catches stale static
 * entries that drift after a manifest removes an action.
 *
 * This is a regex-lite gate (Stage M precedent at
 * `scripts/check-frame-write-single-source.cjs:7-11`). The static literal is
 * a multi-line `Record<string, string>` declaration with quoted
 * `<skillId>:<action>` keys; manifests are JSON. Both shapes are stable.
 *
 * Limitations (documented):
 *   - Regex only matches the forward literal at the canonical declaration
 *     site. If the literal is moved or aliased through a helper, this gate
 *     misses it. Future Stage N.1 may upgrade to AST.
 *   - Custom user-installed skills are out of scope (Stage N Phase 0.4
 *     strips their `child_loop` at compile, so they cannot register
 *     manifest-declared child-loop actions).
 *
 * Exits:
 *   0  — invariant holds
 *   1  — invariant violated (orphans listed)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const DEFAULT_STATIC_FILE = path.join(REPO, 'src/main/modules/tools/skills-tools-static.ts')
const DEFAULT_EMBEDDED_DIR = path.join(REPO, 'assets/embedded-skills')

function parseStaticForwardTable(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const startMarker = 'export const STATIC_SKILL_TOOL_NAMES_BY_ACTION: Record<string, string> = {'
  const startIdx = text.indexOf(startMarker)
  if (startIdx < 0) {
    throw new Error(
      `[Stage N gate] cannot find STATIC_SKILL_TOOL_NAMES_BY_ACTION at ${filePath}`,
    )
  }
  const endIdx = text.indexOf('}', startIdx)
  if (endIdx < 0) {
    throw new Error(`[Stage N gate] unterminated STATIC_SKILL_TOOL_NAMES_BY_ACTION literal at ${filePath}`)
  }
  const body = text.slice(startIdx + startMarker.length, endIdx)
  const entries = []
  const re = /['"]([\w-]+):([\w-]+)['"]\s*:\s*['"]([\w_]+)['"]/g
  let match
  while ((match = re.exec(body)) !== null) {
    entries.push({ skillId: match[1], actionName: match[2], toolName: match[3] })
  }
  return entries
}

function loadEmbeddedManifests(rootDir) {
  if (!fs.existsSync(rootDir)) return []
  const result = []
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(rootDir, entry.name, 'ready-skill.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`[Stage N gate] failed to parse ${manifestPath}: ${error.message}`)
    }
    const id = typeof manifest.id === 'string' && manifest.id.trim()
      ? manifest.id.trim()
      : entry.name
    const childLoop = manifest.child_loop ?? manifest.childLoop ?? null
    const childLoopActions = Array.isArray(childLoop?.actions)
      ? childLoop.actions.filter((a) => typeof a === 'string' && a)
      : []
    result.push({ skillId: id, manifestPath, childLoopActions })
  }
  return result
}

function checkManifestVsStaticToolName(options = {}) {
  const staticFile = options.staticFile || DEFAULT_STATIC_FILE
  const embeddedDir = options.embeddedDir || DEFAULT_EMBEDDED_DIR
  const staticEntries = parseStaticForwardTable(staticFile)
  const manifests = loadEmbeddedManifests(embeddedDir)

  const staticBySkillAction = new Map()
  for (const entry of staticEntries) {
    staticBySkillAction.set(`${entry.skillId}:${entry.actionName}`, entry)
  }

  const childLoopSkillIds = new Set()
  const forwardOrphans = []
  for (const m of manifests) {
    if (m.childLoopActions.length === 0) continue
    childLoopSkillIds.add(m.skillId)
    for (const action of m.childLoopActions) {
      if (!staticBySkillAction.has(`${m.skillId}:${action}`)) {
        forwardOrphans.push({ skillId: m.skillId, action, manifest: m.manifestPath })
      }
    }
  }

  const reverseOrphans = []
  for (const entry of staticEntries) {
    if (!childLoopSkillIds.has(entry.skillId)) continue
    const manifest = manifests.find((m) => m.skillId === entry.skillId)
    if (!manifest) continue
    if (!manifest.childLoopActions.includes(entry.actionName)) {
      reverseOrphans.push({
        skillId: entry.skillId,
        action: entry.actionName,
        manifest: manifest.manifestPath,
      })
    }
  }

  const errors = []
  if (forwardOrphans.length > 0) {
    errors.push(
      'manifest action missing static tool name (child_loop action declared in manifest but not in STATIC_SKILL_TOOL_NAMES_BY_ACTION):',
    )
    for (const o of forwardOrphans) {
      errors.push(`  - ${o.skillId}:${o.action} (manifest: ${o.manifest})`)
    }
  }
  if (reverseOrphans.length > 0) {
    errors.push(
      'static tool action not declared in manifest (STATIC_SKILL_TOOL_NAMES_BY_ACTION has an entry for a child-loop skill but the action is not in manifest child_loop.actions[]):',
    )
    for (const o of reverseOrphans) {
      errors.push(`  - ${o.skillId}:${o.action} (manifest: ${o.manifest})`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      manifestsChecked: manifests.length,
      childLoopSkillCount: childLoopSkillIds.size,
      staticEntryCount: staticEntries.length,
    },
  }
}

function main() {
  const result = checkManifestVsStaticToolName()
  if (!result.ok) {
    console.error('[Stage N: check-manifest-vs-static-tool-name] FAIL')
    for (const line of result.errors) console.error(line)
    process.exit(1)
  }
  const { manifestsChecked, childLoopSkillCount, staticEntryCount } = result.summary
  console.log(
    `[Stage N: check-manifest-vs-static-tool-name] OK — ${manifestsChecked} embedded manifests, ${childLoopSkillCount} declare child_loop, ${staticEntryCount} static entries cross-checked.`,
  )
}

if (require.main === module) {
  main()
}

module.exports = {
  checkManifestVsStaticToolName,
  parseStaticForwardTable,
  loadEmbeddedManifests,
}
