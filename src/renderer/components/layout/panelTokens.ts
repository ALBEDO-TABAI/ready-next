import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT, WORKBENCH_TOOLBAR_ROW_HEIGHT } from '../../modules/workbench/chrome'

export const FILES_PANEL_DIMENSIONS = {
  headerHeight: WORKBENCH_TAB_ROW_HEIGHT,
  toolbarHeight: WORKBENCH_TOOLBAR_ROW_HEIGHT,
  searchHeight: 28,
  searchRadius: 10,
  headerPaddingX: WORKBENCH_HEADER_EDGE_X,
  searchPaddingX: WORKBENCH_HEADER_EDGE_X,
  searchPaddingY: 10,
  listPaddingX: 8,
  listPaddingY: 6,
} as const

export const SKILLS_PANEL_DIMENSIONS = {
  headerHeight: WORKBENCH_TAB_ROW_HEIGHT,
  sectionGap: 8,
  sectionPaddingY: 10,
  sectionPaddingX: WORKBENCH_HEADER_EDGE_X,
  cardRadius: 8,
  dropZoneHeight: 72,
  splitterHeight: 4,
} as const

export const GLOBAL_SEARCH_DIMENSIONS = {
  headerHeight: WORKBENCH_TAB_ROW_HEIGHT,
  controlHeight: 28,
  controlRadius: 10,
  bodyGap: 8,
  bodyPaddingX: WORKBENCH_HEADER_EDGE_X,
  bodyPaddingYTop: 10,
  bodyPaddingYBottom: 10,
} as const

// Shell side-panel colours on Ready's design system (W1 §3, DL1/DL5/DL6): panels are regions on the window
// glass (no background of their own), text uses the four ink levels, and the old blue accent is ink — the
// signal colour is reserved for "here / now" and is chosen where it is used, not here.
export const PANEL_TOKENS = {
  panelBg: 'transparent',
  border: 'var(--rn-hair-2)',
  title: 'var(--rn-ink)',
  sectionTitle: 'var(--rn-ink-2)',
  text: 'var(--rn-ink)',
  muted: 'var(--rn-ink-2)',
  mutedStrong: 'var(--rn-ink-3)',
  placeholder: 'var(--rn-ink-3)',
  cardBg: 'var(--rn-fill)',
  inputBorder: 'var(--rn-hair-2)',
  dropBorder: 'var(--rn-hair-2)',
  iconAccent: 'var(--rn-ink-2)',
  blue: 'var(--rn-ink-2)',
  blueLight: 'var(--rn-fill-2)',
} as const
