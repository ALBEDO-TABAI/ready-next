/**
 * B-arch-2 — Restricted templater for Skill Host Contract.
 *
 * Resolves only `${var.path}` style references against an explicit, whitelisted
 * context. No JS eval, no function calls, no conditionals, no `{{}}`. Only
 * scalar dot-paths walking the supplied context object plus a tiny env
 * allowlist (`HOME`, `XDG_CONFIG_HOME`).
 *
 * Security invariants (enforced by `src/__tests__/contract-templater.test.ts`):
 * - No template syntax other than `${var.path}` is honored.
 * - Cannot read arbitrary env (only HOME / XDG_CONFIG_HOME).
 * - Variable names must satisfy `[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*` (case
 *   insensitive). Anything outside that grammar (e.g. `${exec('rm -rf /')}`,
 *   `${{constructor...}}`) either fails to match the regex (treated as literal)
 *   or — if it does match — fails the unknown-variable check.
 * - This module never logs `${agent.api_key}` (or any other resolved value).
 */

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

export type { AgentSpawnContext }

export interface TemplateContext {
  skill: { id: string; name: string; assetRoot: string }
  agent: AgentSpawnContext
  spawn: { job_id: string; tmp_dir: string; timestamp: string }
  output_dir?: string
}

export class TemplateError extends Error {
  readonly variable?: string
  constructor(message: string, variable?: string) {
    super(message)
    this.name = 'TemplateError'
    this.variable = variable
  }
}

// `${var.path}` — variable names are dot-separated identifiers. Case
// insensitive so `${env.HOME}` works alongside lowercase paths like
// `${agent.model_id}`. Anything with parentheses, quotes, braces, spaces, etc.
// fails to match (the surrounding text is left as a literal `${...}` token,
// which we then reject below).
const VAR_PATTERN = /\$\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\}/gi

// Detects `${...}` openings that we did NOT match as a valid variable. We
// reject these so injection attempts (`${exec('rm -rf /')}`) become hard
// failures instead of silently surviving as literals.
const RESIDUAL_DOLLAR_BRACE = /\$\{/

const ALLOWED_ENV = new Set(['HOME', 'XDG_CONFIG_HOME'])

/**
 * Resolve a single `${var.path}` expression against the context. Returns a
 * string for scalars, JSON-stringified for arrays. Throws TemplateError for
 * unknown variables or non-allowed env vars.
 */
export function resolveVariable(name: string, ctx: TemplateContext): string {
  const parts = name.split('.')
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new TemplateError(`invalid variable name: ${name}`, name)
  }

  // env is special: we read process.env but only for an allowlist.
  if (parts[0] === 'env') {
    if (parts.length !== 2) {
      throw new TemplateError(`invalid env variable: ${name}`, name)
    }
    const envName = parts[1]
    if (!ALLOWED_ENV.has(envName)) {
      throw new TemplateError(
        `env.${envName} is not in the allowlist (only HOME / XDG_CONFIG_HOME are exposed)`,
        name,
      )
    }
    const value = process.env[envName]
    return typeof value === 'string' ? value : ''
  }

  // Walk the structured context.
  const ROOT_KEYS = new Set<keyof TemplateContext>(['skill', 'agent', 'spawn', 'output_dir'])
  const root = parts[0] as keyof TemplateContext
  if (!ROOT_KEYS.has(root)) {
    throw new TemplateError(`unknown variable root: ${parts[0]}`, name)
  }

  // Special case: `${output_dir}` is itself a leaf.
  if (root === 'output_dir') {
    if (parts.length !== 1) {
      throw new TemplateError(`output_dir is a leaf, cannot index: ${name}`, name)
    }
    if (typeof ctx.output_dir !== 'string') {
      throw new TemplateError(`output_dir is not set in template context`, name)
    }
    return ctx.output_dir
  }

  let cursor: unknown = ctx[root]
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i]
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      throw new TemplateError(`cannot index '${key}' on non-object at ${name}`, name)
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) {
      throw new TemplateError(`unknown variable: ${name}`, name)
    }
    cursor = (cursor as Record<string, unknown>)[key]
  }

  if (cursor === null || cursor === undefined) {
    throw new TemplateError(`unknown variable: ${name}`, name)
  }
  if (Array.isArray(cursor)) {
    return JSON.stringify(cursor)
  }
  if (typeof cursor === 'object') {
    throw new TemplateError(`variable ${name} resolves to an object, not a scalar`, name)
  }
  // string / number / boolean — coerce to string.
  return String(cursor)
}

/**
 * Apply template substitution to a string. All `${var}` occurrences are
 * replaced. Throws on unknown variable. Any residual `${...}` opener that
 * didn't match the strict variable grammar is also rejected (so injection
 * attempts surface as errors rather than literals).
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  // First pass: replace every well-formed `${var.path}` occurrence.
  // We track resolution errors and re-throw the first one after the pass so we
  // don't have nested throws inside `replace`.
  let firstError: TemplateError | null = null
  const replaced = template.replace(VAR_PATTERN, (_match, name: string) => {
    try {
      return resolveVariable(name, ctx)
    } catch (err) {
      if (err instanceof TemplateError && firstError === null) {
        firstError = err
      }
      return ''
    }
  })
  if (firstError !== null) {
    throw firstError
  }

  // Second pass: any leftover `${` is an injection / typo. Reject it. We scan
  // the ORIGINAL template (not the replaced one) so successful replacements
  // can't generate false positives.
  // We only flag a `${` if removing all valid `${var}` matches still leaves
  // one behind.
  const stripped = template.replace(VAR_PATTERN, '')
  if (RESIDUAL_DOLLAR_BRACE.test(stripped)) {
    throw new TemplateError(
      'template contains an unsupported ${...} expression — only ${var.path} is allowed',
    )
  }

  return replaced
}

/**
 * Build a fresh template context for one spawn. Generates an 8-char hex job_id
 * and a per-job tmp dir under os.tmpdir().
 */
export function makeTemplateContext(input: {
  skill: { id: string; name: string; assetRoot: string }
  agent: AgentSpawnContext
  output_dir?: string
}): TemplateContext {
  const job_id = randomBytes(4).toString('hex')
  const tmp_dir = join(tmpdir(), `ready-skill-${input.skill.id}-${job_id}`)
  const timestamp = new Date().toISOString()
  return {
    skill: { ...input.skill },
    agent: {
      ...input.agent,
      fallback_chain: [...input.agent.fallback_chain],
      input_modes: [...(input.agent.input_modes ?? ['text'])],
    },
    spawn: { job_id, tmp_dir, timestamp },
    output_dir: input.output_dir,
  }
}

/**
 * Apply a JSON pointer (RFC 6901-ish, just the slash-separated path) write to
 * a parsed object. Creates intermediate objects as needed. Throws on invalid
 * pointer (must start with `/`). Empty pointer (`""`) is rejected because we
 * never want to overwrite the root with a scalar field-write.
 */
export function applyJsonPointer(
  target: Record<string, unknown>,
  pointer: string,
  value: unknown,
): void {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new TemplateError(`invalid JSON pointer: ${pointer}`)
  }
  // Split, drop the leading empty segment, and decode the standard escapes.
  const segments = pointer
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))

  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new TemplateError(`invalid JSON pointer (empty segment): ${pointer}`)
  }

  let cursor: Record<string, unknown> = target
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = cursor[seg]
    if (
      next === null ||
      next === undefined ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
      const created: Record<string, unknown> = {}
      cursor[seg] = created
      cursor = created
    } else {
      cursor = next as Record<string, unknown>
    }
  }
  cursor[segments[segments.length - 1]] = value
}

/**
 * Render a config-file spec. Each `field` value is rendered against the
 * template context, then written into the parsed object at the given JSON
 * pointer. Output format determines serialization:
 *
 * - `json`  → JSON.stringify with 2-space indent
 * - `yaml`  → js-yaml-equivalent stringify (we use `yaml` package, already in deps)
 * - `toml`  → throws `unsupported_format` (V1)
 * - `ini`   → throws `unsupported_format` (V1)
 */
export function renderConfigFileContent(
  fileSpec: {
    format: 'json' | 'yaml' | 'toml' | 'ini'
    fields: Record<string, string>
    preserve_existing?: boolean
  },
  existingContent: string | null,
  ctx: TemplateContext,
): string {
  if (fileSpec.format === 'toml' || fileSpec.format === 'ini') {
    throw new TemplateError(`unsupported_format: ${fileSpec.format}`)
  }

  const preserve = fileSpec.preserve_existing !== false
  let target: Record<string, unknown> = {}
  if (preserve && typeof existingContent === 'string' && existingContent.length > 0) {
    try {
      const parsed: unknown =
        fileSpec.format === 'json' ? JSON.parse(existingContent) : parseYaml(existingContent)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        target = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed existing file: start fresh rather than abort. The whole
      // point of this module is to make spawn safe even when the user's
      // config drifted.
      target = {}
    }
  }

  for (const [pointer, valueTemplate] of Object.entries(fileSpec.fields)) {
    const rendered = renderTemplate(valueTemplate, ctx)
    // If the rendered string parses as JSON (array or object), store the
    // structured value so downstream readers see the real shape (e.g.
    // `${agent.fallback_chain}` should land as a JSON array, not a string).
    let valueToWrite: unknown = rendered
    const trimmed = rendered.trim()
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        valueToWrite = JSON.parse(trimmed)
      } catch {
        // Not JSON after all — keep as string.
        valueToWrite = rendered
      }
    }
    applyJsonPointer(target, pointer, valueToWrite)
  }

  if (fileSpec.format === 'json') {
    return JSON.stringify(target, null, 2)
  }
  // yaml
  return stringifyYaml(target)
}
