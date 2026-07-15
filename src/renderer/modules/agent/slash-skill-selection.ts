export interface SkillMenuItem {
  id: string
  name: string
  description: string
  installed: boolean
  manifestValid: boolean
  defaultAction?: string
  managedPath?: string
  sourcePath?: string
}

function normalizeSkillSearchValue(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '')
}

export function scoreSkillForSlashQuery(skill: SkillMenuItem, rawQuery: string): number {
  const query = normalizeSkillSearchValue(rawQuery)
  const name = normalizeSkillSearchValue(skill.name)
  const id = normalizeSkillSearchValue(skill.id)
  const description = normalizeSkillSearchValue(skill.description)
  if (!query) return skill.installed ? 10 : 5
  if (id === query || name === query) return 100
  if (id.startsWith(query)) return 90
  if (name.startsWith(query)) return 85
  if (id.includes(query)) return 70
  if (name.includes(query)) return 65
  if (description.includes(query)) return 35
  return 0
}

export function filterSlashSkills(skills: SkillMenuItem[], rawQuery: string, limit = 8): SkillMenuItem[] {
  return skills
    .map((skill) => ({ skill, score: scoreSkillForSlashQuery(skill, rawQuery) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name, 'zh-CN'))
    .slice(0, limit)
    .map((item) => item.skill)
}

export function buildSlashSkillInsertion(inputValue: string, cursorPos: number, skillName: string): {
  nextValue: string
  cursorPosition: number
} | null {
  const textBeforeCursor = inputValue.slice(0, cursorPos)
  const match = textBeforeCursor.match(/(?:^|\s)\/([^\s/@]*)$/)
  if (!match) return null

  const token = match[0]
  const slashOffset = token.lastIndexOf('/')
  const slashIndex = (match.index ?? 0) + slashOffset
  const beforeSlash = inputValue.slice(0, slashIndex)
  const afterCursor = inputValue.slice(cursorPos)
  const insertion = `@[${skillName}]`
  return {
    nextValue: beforeSlash + insertion + afterCursor,
    cursorPosition: (beforeSlash + insertion).length,
  }
}

export function buildSlashCommandInsertion(inputValue: string, cursorPos: number, command: string): {
  nextValue: string
  cursorPosition: number
} | null {
  const textBeforeCursor = inputValue.slice(0, cursorPos)
  const match = textBeforeCursor.match(/(?:^|\s)\/([^\s/@]*)$/)
  if (!match) return null
  const slashOffset = match[0].lastIndexOf('/')
  const slashIndex = (match.index ?? 0) + slashOffset
  const beforeSlash = inputValue.slice(0, slashIndex)
  const afterCursor = inputValue.slice(cursorPos)
  const insertion = `/${command} `
  return {
    nextValue: beforeSlash + insertion + afterCursor,
    cursorPosition: (beforeSlash + insertion).length,
  }
}
