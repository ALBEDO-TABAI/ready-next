import { BaseBoxShapeTool } from 'tldraw'

export class ButtonShapeTool extends BaseBoxShapeTool {
  static id = 'ui-button'
  static initial = 'idle'
  shapeType = 'ui-button' as const
}
