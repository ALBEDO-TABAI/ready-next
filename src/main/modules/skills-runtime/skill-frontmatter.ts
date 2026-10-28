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
import { parse as parseYaml } from 'yaml'

import { isDestructiveShellCommand } from '../../../shared/skill-host-contract'

export interface SkillFrontmatter {
  body: string
  metadata: Record<string, string>
}

const DECLARED_BIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Parse the Agent Skills standard executable dependency declaration:
 * `metadata.requires.bins`. Only bare program names are accepted. Paths,
 * shell syntax and Ready's destructive command set are rejected so an
 * imported document cannot widen `skill_run_shell` beyond one named binary.
 */
export function parseSkillRequiredBins(text: string): string[] {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return []
  try {
    const root = asObject(parseYaml(match[1]))
    const metadata = asObject(root?.metadata)
    const requires = asObject(metadata?.requires)
    const bins = Array.isArray(requires?.bins) ? requires.bins : []
    return Array.from(new Set(
      bins
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) =>
          DECLARED_BIN_PATTERN.test(value)
          && !isDestructiveShellCommand(value)),
    ))
  } catch {
    // silent-catch: malformed frontmatter YAML declares no required bins
    return []
  }
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
