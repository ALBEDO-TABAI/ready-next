/** ATX headings in Markdown source, outside fenced code. The page header shows 大纲 at three or more (W3 §4.1). */
export function countMarkdownHeadings(content: string | null | undefined): number {
  if (!content) return 0
  let count = 0
  let fence: string | null = null
  for (const line of content.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
      continue
    }
    if (!fence && /^\s{0,3}#{1,6}\s+\S/.test(line)) count += 1
  }
  return count
}
