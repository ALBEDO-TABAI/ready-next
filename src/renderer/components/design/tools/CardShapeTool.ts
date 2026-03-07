import { BaseBoxShapeTool } from 'tldraw'

export class CardShapeTool extends BaseBoxShapeTool {
  static id = 'ui-card'
  static initial = 'idle'
  shapeType = 'ui-card' as const
}
