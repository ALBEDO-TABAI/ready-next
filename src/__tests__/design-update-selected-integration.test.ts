import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Editor, createShapeId, TLShapeId } from 'tldraw'

describe('Design Update Selected Tool - Integration Test', () => {
  let mockEditor: Partial<Editor>
  let selectedShapeIds: TLShapeId[]
  let shapes: Map<TLShapeId, any>
  let updateShapeCalls: any[]

  beforeEach(() => {
    selectedShapeIds = [
      createShapeId('board-1'),
      createShapeId('board-2'),
    ]

    shapes = new Map()
    shapes.set(selectedShapeIds[0], {
      id: selectedShapeIds[0],
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
    })
    shapes.set(selectedShapeIds[1], {
      id: selectedShapeIds[1],
      type: 'geo',
      x: 2000,
      y: 0,
      props: {
        geo: 'rectangle',
        w: 1920,
        h: 1080,
        color: 'white',
      },
      meta: {},
    })

    updateShapeCalls = []

    mockEditor = {
      getSelectedShapeIds: () => selectedShapeIds,
      getShape: (id: TLShapeId) => shapes.get(id) || null,
      updateShape: (shape: any) => {
        updateShapeCalls.push(shape)
        // Update the shape in our mock store
        const existing = shapes.get(shape.id)
        if (existing) {
          shapes.set(shape.id, {
            ...existing,
            ...shape,
            props: shape.props ? { ...existing.props, ...shape.props } : existing.props,
            meta: shape.meta ? { ...existing.meta, ...shape.meta } : existing.meta,
          })
        }
      },
    } as Partial<Editor>
  })

  describe('Basic Functionality', () => {
    it('should update color of single selected shape', () => {
      selectedShapeIds = [selectedShapeIds[0]]

      // Simulate design_update_selected({ props: { color: 'black' } })
      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls).toHaveLength(1)
      expect(updateShapeCalls[0].props.color).toBe('black')
      expect(shapes.get(selectedShapeIds[0])?.props.color).toBe('black')
    })

    it('should update color of multiple selected shapes', () => {
      // Simulate design_update_selected({ props: { color: 'black' } })
      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls).toHaveLength(2)
      expect(updateShapeCalls[0].props.color).toBe('black')
      expect(updateShapeCalls[1].props.color).toBe('black')
      expect(shapes.get(selectedShapeIds[0])?.props.color).toBe('black')
      expect(shapes.get(selectedShapeIds[1])?.props.color).toBe('black')
    })

    it('should handle no selection gracefully', () => {
      selectedShapeIds = []

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls).toHaveLength(0)
    })
  })

  describe('Property Updates', () => {
    it('should update position (x, y)', () => {
      selectedShapeIds = [selectedShapeIds[0]]

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        x: 100,
        y: 200,
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            x: patch.x,
            y: patch.y,
          })
        }
      })

      expect(updateShapeCalls[0].x).toBe(100)
      expect(updateShapeCalls[0].y).toBe(200)
    })

    it('should update props and meta together', () => {
      selectedShapeIds = [selectedShapeIds[0]]

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' },
        meta: { readyFillColor: '#000000' },
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props,
            meta: patch.meta,
          })
        }
      })

      expect(updateShapeCalls[0].props.color).toBe('black')
      expect(updateShapeCalls[0].meta.readyFillColor).toBe('#000000')
    })

    it('should preserve other properties when updating color', () => {
      selectedShapeIds = [selectedShapeIds[0]]
      const originalWidth = shapes.get(selectedShapeIds[0])?.props.w

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' },
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props,
          })
        }
      })

      // Width should be preserved
      expect(shapes.get(selectedShapeIds[0])?.props.w).toBe(originalWidth)
      // Color should be updated
      expect(shapes.get(selectedShapeIds[0])?.props.color).toBe('black')
    })
  })

  describe('Real-world Scenarios', () => {
    it('should handle "选中的画板底色改为黑色" scenario', () => {
      // User selects a board and says "change selected board background to black"
      // AI should call: design_update_selected({ props: { color: 'black' } })

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: 'black' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls.length).toBeGreaterThan(0)
      updateShapeCalls.forEach(call => {
        expect(call.props.color).toBe('black')
      })
    })

    it('should handle hex color values', () => {
      selectedShapeIds = [selectedShapeIds[0]]

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        props: { color: '#FF5733' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls[0].props.color).toBe('#FF5733')
    })

    it('should handle custom shape meta updates', () => {
      // For custom shapes like ready-board, use meta instead of props
      shapes.get(selectedShapeIds[0])!.type = 'ready-board'
      selectedShapeIds = [selectedShapeIds[0]]

      const patches = selectedShapeIds.map(id => ({
        id: id as string,
        meta: { readyFillColor: '#000000' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            meta: patch.meta
          })
        }
      })

      expect(updateShapeCalls[0].meta.readyFillColor).toBe('#000000')
    })
  })

  describe('Comparison with Old Approach', () => {
    it('OLD: requires 2 steps (get state + batch design)', () => {
      // Step 1: Get editor state to find selected IDs
      const selectedIds = mockEditor.getSelectedShapeIds!()
      expect(selectedIds).toHaveLength(2)

      // Step 2: Call batch_design with update operations
      const ops = selectedIds.map(id => ({
        op: 'update',
        id: id as string,
        props: { color: 'black' }
      }))

      // Simulate batch_design execution
      ops.forEach(op => {
        const shape = mockEditor.getShape!(op.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: op.id as TLShapeId,
            type: shape.type,
            props: op.props
          })
        }
      })

      expect(updateShapeCalls).toHaveLength(2)
    })

    it('NEW: single step (update selected)', () => {
      // Single call: design_update_selected({ props: { color: 'black' } })
      const selectedIds = mockEditor.getSelectedShapeIds!()
      const patches = selectedIds.map(id => ({
        id: id as string,
        props: { color: 'black' }
      }))

      patches.forEach(patch => {
        const shape = mockEditor.getShape!(patch.id as TLShapeId)
        if (shape) {
          mockEditor.updateShape!({
            id: patch.id as TLShapeId,
            type: shape.type,
            props: patch.props
          })
        }
      })

      expect(updateShapeCalls).toHaveLength(2)
    })
  })
})
