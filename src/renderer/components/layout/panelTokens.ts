import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT, WORKBENCH_TOOLBAR_ROW_HEIGHT } from '../../modules/workbench/chrome'

export const SIDE_PANEL_DIMENSIONS = {
  defaultWidth: 220,
  minWidth: 220,
  maxWidth: 420,
} as const

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

export const PANEL_TOKENS = {
  panelBg: 'var(--lg-content-bg, var(--surface-panel-bg))',
  border: 'var(--lg-content-border, var(--surface-border))',
  title: 'var(--text-title)',
  sectionTitle: 'var(--text-secondary)',
  text: 'var(--text-body)',
  muted: 'var(--text-muted)',
  mutedStrong: 'var(--text-light)',
  placeholder: 'var(--text-placeholder)',
  cardBg: 'var(--lg-content-card-bg, var(--surface-card-bg))',
  inputBorder: 'var(--border-input)',
  dropBorder: 'var(--lg-content-border, var(--surface-border))',
  iconAccent: 'var(--color-gold)',
  blue: 'var(--color-blue)',
  blueLight: 'var(--color-blue-light)',
} as const
