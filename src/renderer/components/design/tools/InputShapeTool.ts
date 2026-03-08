import { BaseBoxShapeTool } from 'tldraw'

export class InputShapeTool extends BaseBoxShapeTool {
  static id = 'ui-input'
  static initial = 'idle'
  shapeType = 'ui-input' as const
}
