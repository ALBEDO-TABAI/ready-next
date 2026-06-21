export interface ReadyLogoDot {
  x: number
  y: number
  r: number
  columnIndex: number
}

export interface ReadyLogoDotPattern {
  dots: ReadyLogoDot[]
  columnCount: number
}

interface ReadyLogoDotPatternOptions {
  xOffset: number
  yOffset: number
  matrixXStart: number
  matrixColumnStep: number
}

interface ParsedSvgCircle {
  cx: number
  cy: number
  r: number
  matrixColumn: number
}

function readNumericAttr(tag: string, attr: string): number {
  const match = tag.match(new RegExp(`\\b${attr}="([^"]+)"`))
  if (!match) return Number.NaN
  return Number(match[1])
}

export function createReadyLogoDotPattern(
  svg: string,
  options: ReadyLogoDotPatternOptions,
): ReadyLogoDotPattern {
  const circles: ParsedSvgCircle[] = []
  const circleTagPattern = /<circle\b[^>]*>/g

  for (const match of svg.matchAll(circleTagPattern)) {
    const tag = match[0]
    const cx = readNumericAttr(tag, 'cx')
    const cy = readNumericAttr(tag, 'cy')
    const r = readNumericAttr(tag, 'r')
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) continue

    circles.push({
      cx,
      cy,
      r,
      matrixColumn: Math.round((cx + options.xOffset - options.matrixXStart) / options.matrixColumnStep),
    })
  }

  if (circles.length === 0) {
    throw new Error('Ready logo SVG does not contain dot circles')
  }

  const columns = [...new Set(circles.map((circle) => circle.matrixColumn))].sort((a, b) => a - b)
  const columnIndexByMatrixColumn = new Map(columns.map((column, index) => [column, index]))

  return {
    dots: circles.map((circle) => ({
      x: Number((circle.cx + options.xOffset).toFixed(1)),
      y: Number((circle.cy + options.yOffset).toFixed(1)),
      r: circle.r,
      columnIndex: columnIndexByMatrixColumn.get(circle.matrixColumn) ?? 0,
    })),
    columnCount: columns.length,
  }
}
