export function tokenizeLarkCliCommand(command: string): string[] | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const tokens: string[] = []
  let current = ''
  let tokenStarted = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] || ''
    const next = trimmed[index + 1] || ''
    if (char === '\\' && next) {
      const escapesNext = quote === '"'
        ? next === '"' || next === '\\'
        : quote === "'"
          ? next === "'" || next === '\\'
          : /\s|["'\\;&|<>]/.test(next)
      if (escapesNext) {
        current += next
        tokenStarted = true
        index += 1
        continue
      }
    }
    if (char === '"' || char === "'") {
      if (quote === char) quote = null
      else if (quote === null) quote = char
      else current += char
      tokenStarted = true
      continue
    }
    if (quote === null && /[;&|<>\n\r]/.test(char)) return null
    if (quote === null && /\s/.test(char)) {
      if (tokenStarted) tokens.push(current)
      current = ''
      tokenStarted = false
      continue
    }
    current += char
    tokenStarted = true
  }
  if (quote !== null) return null
  if (tokenStarted) tokens.push(current)
  return tokens
}
