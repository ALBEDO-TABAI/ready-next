import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Prompt asset loader (EP1-X3). Externalizes prompt/reminder copy into
 * versioned markdown files so wording can be diffed, rolled back, and (later)
 * A/B'd — instead of being hardcoded in TS. Electron-free by design (takes
 * candidate roots) so it unit-tests without standing up the app; the
 * electron-coupled root resolution lives in `roots.ts`.
 */

export interface PromptAsset {
  name: string
  version: string
  description: string
  variables: string[]
  body: string
}

export interface PromptAssetLoaderOptions {
  /** Candidate dirs; first one containing the asset wins (dev/prod parity). */
  roots: string[]
  /** assetKey → hardcoded body, used when no file is found in any root. */
  fallbacks?: Record<string, string>
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { meta: {}, body: normalized }
  const meta: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!entry) continue
    meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: normalized.slice(match[0].length) }
}

function parseVariables(raw: string | undefined): string[] {
  if (!raw) return []
  // Accept `variables: [a, b]` or `variables: a, b`.
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

export class PromptAssetLoader {
  private readonly roots: string[]
  private readonly fallbacks: Record<string, string>
  private readonly cache = new Map<string, PromptAsset>()

  constructor(options: PromptAssetLoaderOptions) {
    this.roots = options.roots
    this.fallbacks = options.fallbacks ?? {}
  }

  /** Reset the parse cache (tests / hot-reload). */
  clearCache(): void {
    this.cache.clear()
  }

  /** Load and parse an asset by key (path without `.md`). Caches the result. */
  load(assetKey: string): PromptAsset {
    const cached = this.cache.get(assetKey)
    if (cached) return cached
    for (const root of this.roots) {
      const filePath = join(root, `${assetKey}.md`)
      if (!existsSync(filePath)) continue
      const { meta, body } = parseFrontmatter(readFileSync(filePath, 'utf-8'))
      const asset: PromptAsset = {
        name: meta.name || assetKey,
        version: meta.version || '0',
        description: meta.description || '',
        variables: parseVariables(meta.variables),
        body: body.trim(),
      }
      this.cache.set(assetKey, asset)
      return asset
    }
    const fallback = this.fallbacks[assetKey]
    if (fallback !== undefined) {
      const asset: PromptAsset = {
        name: assetKey,
        version: 'fallback',
        description: '',
        variables: [],
        body: fallback.trim(),
      }
      this.cache.set(assetKey, asset)
      return asset
    }
    throw new Error(`[prompt-assets] asset not found and no fallback: ${assetKey}`)
  }

  /**
   * Render an asset with variable substitution. Throws (never renders a
   * half-finished prompt) when a placeholder has no provided value or a
   * placeholder is not declared in frontmatter `variables`.
   */
  render(assetKey: string, vars: Record<string, string> = {}): string {
    const asset = this.load(assetKey)
    const declared = new Set(asset.variables)
    const seen = new Set<string>()
    const rendered = asset.body.replace(PLACEHOLDER, (_match, name: string) => {
      seen.add(name)
      if (!declared.has(name)) {
        throw new Error(`[prompt-assets] ${assetKey}: placeholder {{${name}}} not declared in variables`)
      }
      const value = vars[name]
      if (value === undefined) {
        throw new Error(`[prompt-assets] ${assetKey}: missing value for variable {{${name}}}`)
      }
      return value
    })
    // Declared-but-unused variables are allowed (forward-compat); unused values
    // in `vars` are ignored. Only missing/undeclared placeholders are fatal.
    void seen
    return rendered
  }
}
