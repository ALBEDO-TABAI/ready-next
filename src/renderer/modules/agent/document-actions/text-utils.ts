export function raceWithTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`docaction-timeout:${label}:${ms}`)), ms)
    op.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function normalizeContentForCompare(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function hashContent(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0xdeadbeef
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822507)
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0
  h2 = (h2 ^ (h2 >>> 13)) >>> 0
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}


export function findAllReplacementRanges(source: string, target: string): Array<{ start: number; end: number }> {
  if (!target) return []
  const ranges: Array<{ start: number; end: number }> = []
  let searchFrom = 0
  while (searchFrom <= source.length) {
    const nextIndex = source.indexOf(target, searchFrom)
    if (nextIndex < 0) break
    ranges.push({ start: nextIndex, end: nextIndex + target.length })
    searchFrom = nextIndex + Math.max(1, target.length)
  }
  return ranges
}
