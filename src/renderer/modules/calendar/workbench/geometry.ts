// Grid metrics of the calendar, derived from Ready's own design system (W1 §3.1): the 4-pt space scale
// (--rn-s1 … --rn-s14), the type scale (--rn-fs-*), the density tokens (--rn-row-h 30, --rn-control-h 28) and the
// calendar drawn on the design reference page (docs/design/ready-next-design-reference.html). styles/app.css uses
// the same tokens; these are the numbers the layout code needs in JavaScript. They replace values that had been
// measured from a reference product (B13, M8 audit §C).

const S1 = 4, S2 = 8, S3 = 12, S4 = 16, S5 = 20, S6 = 24, S10 = 40, S14 = 56; // --rn-s1 … --rn-s14
const ROW_H = 30;     // --rn-row-h
const CONTROL_H = 28; // --rn-control-h

/** Event chips: title in --rn-fs-xs (11px), time in --rn-fs-2xs (10px), at the reference page's event leading
 *  (1.35, so 15 and 14 px line boxes). */
export const CHIP = {
  padTop: S1,
  titleLine: 15,
  timeLine: 14,
  /** Left under a timed event so back-to-back events read as two. */
  gapBelow: S1,
  /** A free strip right of the events in a day column, where a click still creates an event. */
  gapRight: S2,
  /** A five-minute event still shows as a sliver. */
  minHeight: S3,
  /** All-day and month bars: one --rn-s5 line, --rn-s1 between rows. */
  barHeight: S5,
  barGap: S1,
} as const;
/** A timed event shows its title and time on two lines once it is this tall; shorter, they share one line. */
export const CHIP_TWO_LINES = CHIP.padTop * 2 + CHIP.titleLine + CHIP.timeLine;

export const G = {
  /** Day names sit in one list row, in the week and in the month. */
  colHeader: ROW_H,
  monthColHeader: ROW_H,
  /** The all-day strip is one control high with a single row of bars; with two rows it is a band (52, --rn-band-h). */
  allDayBase: CONTROL_H,
  allDayPadTop: S1,
  allDayChip: CHIP.barHeight,
  allDaySpacing: CHIP.barGap,
  chipMinHeight: CHIP.minHeight,
  chipMarginBottom: CHIP.gapBelow,
  chipMarginRight: CHIP.gapRight,
  /** Half an hour is one control (28), so an hour is 56 (--rn-s14) and a quarter hour 14. */
  defaultHour: S14,
  /** One zoom step adds or removes a quarter hour of the default height. */
  densityStep: S14 / 4,
  /** Zooming in stops at four times the default; zooming out at --rn-s4 an hour (or a day that fills the view). */
  maxHour: S14 * 4,
  minHour: S4,
  /** One time-zone column holds the widest hour label (“上午 10 时” in --rn-fs-2xs) and its --rn-s2 inset. */
  zoneColumn: S14,
  /** Before the first zone column: the margin of the add-zone button. */
  gutterInset: S2,
  /** Below this grid width the gutter gives way to the day: a fifth of the grid, at least --rn-s10. */
  narrowGrid: 300,
  minGutter: S10,
  minCol: S4,
  /** Month cells: the date number sits in a control-high line (a --rn-s5 pill, --rn-s1 around it); the bars follow. */
  monthHeader: CONTROL_H,
  /** The layer entries (documents, to-dos, footprints; W4 §5) keep a strip under the week's day names and the bottom
   *  of each month cell. */
  layerArea: S10 + S2,
  weekNumberGutter: S6,
  /** Bars inside a month cell: --rn-s1 from the left edge; --rn-s3 kept free on the right to click the day. */
  monthBarInsetLeft: S1,
  monthBarInsetRight: S3,
} as const;

export const gutterWidth = (tzCount: number, gridWidth?: number) => {
  const w = G.gutterInset + G.zoneColumn * Math.max(1, tzCount);
  return gridWidth !== undefined && gridWidth < G.narrowGrid ? Math.max(G.minGutter, Math.min(w, gridWidth / 5)) : w;
};
export const colWidth = (gridWidth: number, gutter: number, n: number) => Math.max(G.minCol, Math.ceil((gridWidth - gutter) / n));
/** Hour row height for a density level, never smaller than "24 hours fill the viewport". */
export const hourHeight = (level: number, available: number) => Math.max(G.defaultHour + G.densityStep * level, available / 24, G.minHour);
export const minHourFor = (available: number) => Math.max(available / 24, G.minHour);
export const minDensityLevel = (available: number) => -Math.ceil((G.defaultHour - minHourFor(available)) / G.densityStep - 1e-9);
export const maxDensityLevel = Math.floor((G.maxHour - G.defaultHour) / G.densityStep);
/** Height of the all-day strip holding `rows` rows of bars. */
export const allDayHeight = (rows: number) => Math.max(G.allDayBase, G.allDayPadTop * 2 + rows * G.allDayChip + Math.max(0, rows - 1) * G.allDaySpacing);
/** Top of the first bar row in a month cell whose top is `top` (inside its 1 px border). */
export const monthBarsTop = (top: number) => top + 1 + G.monthHeader;
/** Bar rows that fit in a month cell `rowHeight` tall above its layer area. When a day has more, its last row
 *  becomes the “+ more” line. */
export const monthRowsFit = (rowHeight: number) =>
  Math.max(1, Math.floor((rowHeight - 1 - G.monthHeader - G.layerArea) / (G.allDayChip + G.allDaySpacing)));
