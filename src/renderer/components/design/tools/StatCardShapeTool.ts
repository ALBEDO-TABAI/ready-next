import { BaseBoxShapeTool } from 'tldraw'

export class StatCardShapeTool extends BaseBoxShapeTool {
  static id = 'ui-stat-card'
  static initial = 'idle'
  shapeType = 'ui-stat-card' as const
}
