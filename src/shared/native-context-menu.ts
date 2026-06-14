export interface NativeContextMenuItem {
  id: string
  label: string
  enabled?: boolean
  separator?: boolean
  checked?: boolean
  iconText?: string
  iconKey?: 'user' | 'theme-light' | 'theme-dark' | 'settings'
  accelerator?: string
}

export interface NativeContextMenuRequest {
  x: number
  y: number
  items: NativeContextMenuItem[]
  presentation?: 'native' | 'floating'
}

export interface NativeContextMenuResponse {
  success: boolean
  selectedId?: string
  dismissed?: boolean
  error?: string
}
