export interface BookLocation { chapter: number; from: number; to: number }
export function parseBookLocation(loc: string): BookLocation {
  const match = /^c(\d+):(\d+)\+(\d+)$/.exec(loc)
  if (!match) throw new Error('书内位置无效')
  const chapter = Number(match[1]), from = Number(match[2]), length = Number(match[3]), to = from + length
  if (![chapter, from, length, to].every(Number.isSafeInteger) || length < 1) throw new Error('书内位置无效')
  return { chapter, from, to }
}

