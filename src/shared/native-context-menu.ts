export interface NativeContextMenuItem {
  id: string
  label: string
  enabled?: boolean
  separator?: boolean
  checked?: boolean
  iconText?: string
  accelerator?: string
}

export interface NativeContextMenuRequest {
  x: number
  y: number
  items: NativeContextMenuItem[]
}

export interface NativeContextMenuResponse {
  success: boolean
  selectedId?: string
  dismissed?: boolean
  error?: string
}
