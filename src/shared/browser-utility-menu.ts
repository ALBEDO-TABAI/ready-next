export type BrowserUtilityMenuKind = 'bookmarks' | 'downloads' | 'more'

export interface BrowserUtilityMenuCurrentTab {
  id: string
  url: string
  title: string
  domain: string
}

export interface BrowserUtilityMenuAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface BrowserUtilityMenuRequest {
  kind: BrowserUtilityMenuKind
  anchorRect: BrowserUtilityMenuAnchorRect
  currentTab?: BrowserUtilityMenuCurrentTab | null
  currentDomain?: string
  adblockEnabled?: boolean
  adblockDomainWhitelisted?: boolean
}
