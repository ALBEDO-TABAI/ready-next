export interface CanvasExportImageRequest {
  /** Window content coordinates in DIP; width/height must be positive. */
  rect: { x: number; y: number; width: number; height: number }
  suggestedName?: string
}
export type CanvasExportImageResult = { success: true; path: string }
  | { success: false; canceled: true }
  | { success: false; error: string }
