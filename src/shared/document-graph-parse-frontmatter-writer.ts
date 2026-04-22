import { stringify as stringifyYaml } from 'yaml'

/**
 * Replace (or insert) a YAML frontmatter block at the top of a Markdown
 * document. If the document already starts with a `---` fence, the existing
 * block is replaced; otherwise a new block is prepended.
 *
 * Idempotent: writing the same frontmatter twice produces the same output.
 */
export function writeFrontmatter(content: string, frontmatter: Record<string, unknown>): string {
  const hasFrontmatter = /^---\s*\n/.test(content)
  const yamlBody = stringifyYaml(frontmatter).replace(/\n$/, '')
  const block = `---\n${yamlBody}\n---\n`
  if (!hasFrontmatter) {
    const prefix = content.startsWith('\n') ? '' : ''
    return `${block}${prefix}${content}`
  }
  const endIdx = content.indexOf('\n---', 3)
  if (endIdx < 0) return `${block}${content}`
  const rest = content.slice(endIdx + '\n---'.length).replace(/^\n/, '')
  return `${block}${rest}`
}
