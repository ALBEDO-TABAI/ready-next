export type LocalFileReference = {
  kind: 'file'
  path: string
  line: number | null
  raw: string
}

export type LocalMentionReference = {
  kind: 'mention'
  name: string
  raw: string
}

export type LocalReference = LocalFileReference | LocalMentionReference

export type MentionResolution = {
  path?: string
  line?: number | null
  kind?: string
}

const LOCAL_REFERENCE_RE = /(@\[([^\]]+)\])|((?:\/(?:Users|home|Volumes|private|var|tmp)\/)[^\s"'<>`)]+)(?:\s*\(line\s+(\d+)\))?/g

export function parseLocalReferences(text: string): Array<string | LocalReference> {
  const parts: Array<string | LocalReference> = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  LOCAL_REFERENCE_RE.lastIndex = 0
  while ((match = LOCAL_REFERENCE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    if (match[1]) {
      parts.push({ kind: 'mention', name: match[2], raw: match[1] })
    } else {
      parts.push({
        kind: 'file',
        path: match[3],
        line: match[4] ? Number(match[4]) : null,
        raw: match[0],
      })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length > 0 ? parts : [text]
}

export function fileReferenceLabel(path: string, line: number | null): string {
  const segments = path.split('/').filter(Boolean)
  const name = segments[segments.length - 1] || path
  return line ? `${name} (line ${line})` : name
}

export function fileReferenceDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return ''
  return path.slice(0, slash + 1)
}

export function resolveMentionReference(
  name: string,
  mentions?: Readonly<Record<string, MentionResolution>> | null,
): MentionResolution | null {
  const resolved = mentions?.[name]
  if (!resolved) return null
  return resolved
}
