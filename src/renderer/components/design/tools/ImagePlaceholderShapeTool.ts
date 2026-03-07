import { BaseBoxShapeTool } from 'tldraw'

export class ImagePlaceholderShapeTool extends BaseBoxShapeTool {
  static id = 'ui-image-placeholder'
  static initial = 'idle'
  shapeType = 'ui-image-placeholder' as const
}
