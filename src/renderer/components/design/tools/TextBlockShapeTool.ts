import { BaseBoxShapeTool } from 'tldraw'

export class TextBlockShapeTool extends BaseBoxShapeTool {
  static id = 'ui-text-block'
  static initial = 'idle'
  shapeType = 'ui-text-block' as const
}
