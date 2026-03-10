import { BaseBoxShapeTool } from 'tldraw'

export class ListItemShapeTool extends BaseBoxShapeTool {
  static id = 'ui-list-item'
  static initial = 'idle'
  shapeType = 'ui-list-item' as const
}
