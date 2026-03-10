import { BaseBoxShapeTool } from 'tldraw'

export class SectionBlockShapeTool extends BaseBoxShapeTool {
  static id = 'ui-section-block'
  static initial = 'idle'
  shapeType = 'ui-section-block' as const
}
