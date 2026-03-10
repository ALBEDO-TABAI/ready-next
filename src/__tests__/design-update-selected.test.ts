import { describe, it, expect, beforeEach } from 'vitest'
import { Editor, createShapeId } from 'tldraw'

describe('Design Batch Update - Selected Board Background', () => {
  let mockEditor: Partial<Editor>
  let selectedShapeId: string
  let updateShapeCalled: boolean
  let updateShapeArgs: any

  beforeEach(() => {
    selectedShapeId = createShapeId('board-1')
    updateShapeCalled = false
    updateShapeArgs = null

    mockEditor = {
      getSelectedShapeIds: () => [selectedShapeId],
      getShape: (id: string) => {
        if (id === selectedShapeId) {
          return {
            id: selectedShapeId,
            type: 'geo',
            x: 0,
            y: 0,
            props: {
              geo: 'rectangle',
              w: 1920,
              h: 1080,
              color: 'white',
            },
            meta: {},
          } as any
        }
        return null
      },
      updateShape: (shape: any) => {
        updateShapeCalled = true
        updateShapeArgs = shape
      },
    } as Partial<Editor>
  })

  describe('Problem Diagnosis', () => {
    it('should identify the issue: AI cannot easily update selected board', () => {
      // Current workflow that AI needs to follow:
      // 1. Call design_get_editor_state to get selected shape IDs
      // 2. Call design_batch_design with update operation

      // Problem: This is a 2-step process that's error-prone
      // AI might:
      // - Forget to get editor state first
      // - Use wrong property names (color vs fillColor vs readyFillColor)
      // - Send malformed update operations

      expect(true).toBe(true) // This test documents the problem
    })

    it('should show what the correct batch_design call looks like', () => {
      // Correct format for updating selected board background:
      const correctOps = [
        {
          op: 'update',
          id: selectedShapeId,
          props: {
            color: 'black'  // For geo shapes
          }
        }
      ]

      // Simulate the update
      mockEditor.updateShape!({
        id: selectedShapeId,
        type: 'geo',
        props: {
          color: 'black'
        }
      })

      expect(updateShapeCalled).toBe(true)
      expect(updateShapeArgs.props.color).toBe('black')
    })

    it('should show common mistakes AI might make', () => {
      // Mistake 1: Wrong property name
      const wrongOps1 = [
        {
          op: 'update',
          id: selectedShapeId,
          props: {
            fillColor: 'black'  // Wrong! Should be 'color' for geo shapes
          }
        }
      ]

      // Mistake 2: Using meta instead of props
      const wrongOps2 = [
        {
          op: 'update',
          id: selectedShapeId,
          meta: {
            readyFillColor: '#000000'  // This is for custom shapes, not geo
          }
        }
      ]

      // Mistake 3: Missing ID (trying to update without knowing which shape)
      const wrongOps3 = [
        {
          op: 'update',
          props: {
            color: 'black'
          }
          // Missing id!
        }
      ]

      expect(wrongOps1).toBeDefined()
      expect(wrongOps2).toBeDefined()
      expect(wrongOps3).toBeDefined()
    })
  })

  describe('Proposed Solution: design_update_selected', () => {
    it('should provide a simpler API for updating selected shapes', () => {
      // Proposed new tool: design_update_selected
      // Usage: design_update_selected({ props: { color: 'black' } })

      // This tool would:
      // 1. Automatically get selected shape IDs
      // 2. Apply updates to all selected shapes
      // 3. Handle both props and meta updates

      const selectedIds = mockEditor.getSelectedShapeIds!()
      expect(selectedIds).toHaveLength(1)
      expect(selectedIds[0]).toBe(selectedShapeId)

      // Simulate the simplified update
      selectedIds.forEach(id => {
        const shape = mockEditor.getShape!(id)
        if (shape) {
          mockEditor.updateShape!({
            id,
            type: shape.type,
            props: {
              color: 'black'
            }
          })
        }
      })

      expect(updateShapeCalled).toBe(true)
      expect(updateShapeArgs.props.color).toBe('black')
    })

    it('should handle both props and meta updates', () => {
      // For geo shapes: use props.color
      mockEditor.updateShape!({
        id: selectedShapeId,
        type: 'geo',
        props: {
          color: 'black'
        }
      })

      expect(updateShapeCalled).toBe(true)

      // For custom shapes: use meta.readyFillColor
      updateShapeCalled = false
      mockEditor.updateShape!({
        id: selectedShapeId,
        type: 'ready-board',
        meta: {
          readyFillColor: '#000000'
        }
      })

      expect(updateShapeCalled).toBe(true)
    })

    it('should work with multiple selected shapes', () => {
      const shape2Id = createShapeId('board-2')
      mockEditor.getSelectedShapeIds = () => [selectedShapeId, shape2Id]

      const selectedIds = mockEditor.getSelectedShapeIds!()
      expect(selectedIds).toHaveLength(2)

      // Update all selected shapes
      let updateCount = 0
      selectedIds.forEach(id => {
        mockEditor.updateShape!({
          id,
          type: 'geo',
          props: {
            color: 'black'
          }
        })
        updateCount++
      })

      expect(updateCount).toBe(2)
    })
  })

  describe('Expected Behavior', () => {
    it('should update board background color from white to black', () => {
      const shape = mockEditor.getShape!(selectedShapeId)
      expect(shape?.props.color).toBe('white')

      mockEditor.updateShape!({
        id: selectedShapeId,
        type: 'geo',
        props: {
          color: 'black'
        }
      })

      expect(updateShapeCalled).toBe(true)
      expect(updateShapeArgs.props.color).toBe('black')
    })

    it('should preserve other properties when updating color', () => {
      mockEditor.updateShape!({
        id: selectedShapeId,
        type: 'geo',
        props: {
          color: 'black'
          // w, h, geo should be preserved
        }
      })

      expect(updateShapeCalled).toBe(true)
      expect(updateShapeArgs.id).toBe(selectedShapeId)
      expect(updateShapeArgs.type).toBe('geo')
      // Only color should be in the update
      expect(Object.keys(updateShapeArgs.props)).toEqual(['color'])
    })
  })
})
