'use strict'
/**
 * P3-3 — shared agentskills.io-spec lint rules for a single skill directory.
 *
 * ONE rule engine consumed by both the CLI (scripts/lint-skill.cjs) and the import pipeline
 * (custom-skill-registry, best-effort) — do NOT copy these rules elsewhere. Pure: it takes the
 * already-read directory inputs and returns { errors, warnings }; the caller does the fs reads.
 *
 * Identity-source aware (mirrors the P2-3 gate): a skill with ready-skill.json derives its identity
 * from json.id (validated against the dir name); a BARE SKILL.md skill derives it from the frontmatter
 * name. So the frontmatter name checks apply only to bare skills — this is why linting the embedded
 * skills (all json-backed, a few with intentional short SKILL.md names like `vea`) yields ERROR=0.
 */

const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
const DESCRIPTION_MAX = 1024
const BODY_CHAR_WARN = 12000 // Ready L2 inline cap — over this, activation-time truncation
const BODY_LINE_WARN = 500 // agentskills.io authoring guidance

function parseFrontmatter(text) {
  const normalized = String(text || '').replace(/^﻿/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return {}
  const meta = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const entry = rawLine.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (entry) meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return meta
}

function hasAllowedToolsKey(record) {
  return Object.keys(record || {}).some((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === 'allowedtools')
}

/**
 * @param {{ dirName: string, json: object|null, skillMd: string|null, hasScripts: boolean, enforceIdMatchesDir?: boolean }} inputs
 * @returns {{ errors: string[], warnings: string[] }}
 *
 * `enforceIdMatchesDir` (default true) — the agentskills.io "name MUST match dir name" rule. The CLI /
 * gate / authoring pass true. The IMPORT pipeline passes FALSE: it receives staging folders with
 * arbitrary names (extract / <repo>-<sha> / a UUID) and derives identity from the frontmatter, so the
 * dir-name match must not reject a legitimate import.
 */
function lintSkillInputs(inputs) {
  const { dirName, json, skillMd, hasScripts } = inputs
  const enforceIdMatchesDir = inputs.enforceIdMatchesDir !== false
  const errors = []
  const warnings = []
  const hasJson = json && typeof json === 'object'
  const hasSkillMd = typeof skillMd === 'string'

  if (!hasJson && !hasSkillMd) {
    errors.push('缺少 SKILL.md（且无 ready-skill.json）')
    return { errors, warnings }
  }

  if (hasJson) {
    const id = typeof json.id === 'string' ? json.id.trim() : ''
    if (!id) errors.push('ready-skill.json 缺少 id')
    else if (enforceIdMatchesDir && id !== dirName) errors.push(`ready-skill.json id "${id}" 必须等于目录名 "${dirName}"`)
    const desc = typeof json.description === 'string' ? json.description.trim() : ''
    if (!desc) errors.push('ready-skill.json 缺少 description')
    else if (desc.length > DESCRIPTION_MAX) errors.push(`ready-skill.json description 超过 ${DESCRIPTION_MAX} 字符（${desc.length}）`)
  } else {
    const meta = parseFrontmatter(skillMd)
    const name = (meta.name || '').trim()
    const description = (meta.description || '').trim()
    if (!name) {
      errors.push('SKILL.md frontmatter 缺少 name')
    } else {
      if (name.includes('--')) errors.push(`SKILL.md name "${name}" 不得包含 "--"`)
      else if (!SKILL_NAME_RE.test(name)) errors.push(`SKILL.md name "${name}" 不符合 ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`)
      if (enforceIdMatchesDir && name !== dirName) errors.push(`SKILL.md name "${name}" 必须等于目录名 "${dirName}"`)
    }
    if (!description) errors.push('SKILL.md frontmatter 缺少 description')
    else if (description.length > DESCRIPTION_MAX) errors.push(`SKILL.md description 超过 ${DESCRIPTION_MAX} 字符（${description.length}）`)
  }

  if (hasSkillMd) {
    if (skillMd.length > BODY_CHAR_WARN) warnings.push(`SKILL.md 超过 ${BODY_CHAR_WARN} 字符，激活时将被 L2 截断内联`)
    const lineCount = skillMd.split(/\r?\n/).length
    if (lineCount > BODY_LINE_WARN) warnings.push(`SKILL.md 超过 ${BODY_LINE_WARN} 行（${lineCount}）`)
    if (hasAllowedToolsKey(parseFrontmatter(skillMd))) warnings.push('frontmatter 含 allowed-tools（Ready 忽略该字段——工具面只由 Ready 授权层决定）')
    if (hasScripts && !/\$CLAUDE_SKILL_DIR/.test(skillMd)) warnings.push('存在 scripts/ 但 SKILL.md 未提及 $CLAUDE_SKILL_DIR（脚本无法定位技能目录）')
  }

  return { errors, warnings }
}

module.exports = { lintSkillInputs, SKILL_NAME_RE, DESCRIPTION_MAX, BODY_CHAR_WARN, BODY_LINE_WARN }
