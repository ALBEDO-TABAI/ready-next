/**
 * Shared SKILL.md frontmatter parser (P2-3).
 *
 * One flat YAML-ish frontmatter reader used by BOTH the embedded manifest scan
 * (`manifest.buildEmbeddedSkillManifests`) and the custom-skill importer
 * (`custom-skill-registry`). Zero third-party deps. Deliberately flat (top-level
 * `key: value` only) — nested blocks (e.g. `metadata:\n  version: x`) collapse their
 * indented leaf keys to the top level, which is enough for the fields we read
 * (name / description / version). Unknown fields are kept verbatim (spec tolerance,
 * P2-4): the caller decides which keys to honor.
 */

export interface SkillFrontmatter {
  body: string
  metadata: Record<string, string>
}

/**
 * Parse leading `--- ... ---` frontmatter into a flat string map + the remaining body.
 * No frontmatter → `{ body: <input>, metadata: {} }`.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) {
    return { body: normalized, metadata: {} }
  }

  const metadata: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (!entry) continue
    metadata[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }

  return { body: normalized.slice(match[0].length), metadata }
}
