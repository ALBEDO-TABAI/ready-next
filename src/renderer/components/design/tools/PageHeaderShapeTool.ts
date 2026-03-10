import { BaseBoxShapeTool } from 'tldraw'

export class PageHeaderShapeTool extends BaseBoxShapeTool {
  static id = 'ui-page-header'
  static initial = 'idle'
  shapeType = 'ui-page-header' as const
}
