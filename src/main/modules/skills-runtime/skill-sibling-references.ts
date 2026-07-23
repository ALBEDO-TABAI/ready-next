const SIBLING_SKILL_LINK =
  /\]\(\.\.\/([A-Za-z0-9][A-Za-z0-9._-]*)\/SKILL\.md(?:#[^)]+)?\)/g

export function parseSiblingSkillReferenceIds(documentText: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of String(documentText || '').matchAll(SIBLING_SKILL_LINK)) {
    const id = match[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
