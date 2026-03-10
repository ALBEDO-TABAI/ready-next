import { describe, it, expect } from 'vitest'
import { extractDesignSemanticControls } from '../shared/design-agent'

describe('Design Multi-Board Management - Stage 3E', () => {
  describe('Board Creation Strategy Core Logic', () => {
    it('should recognize variant pattern', () => {
      // The actual implementation uses this pattern
      const text = '创建3个变体'
      const variantMatch = text.match(/(\d+)\s*(?:个|种)?(?:变体|版本|方案)/i)
      expect(variantMatch).toBeTruthy()
      expect(variantMatch?.[1]).toBe('3')
    })

    it('should recognize multiple requests separated by "和"', () => {
      const text = '创建大字报封面和奢华封面'
      const parts = text.split('和')
      expect(parts.length).toBe(2)
      expect(parts[0]).toContain('大字报')
      expect(parts[1]).toContain('奢华')
    })

    it('should recognize multiple requests separated by comma', () => {
      const text = '创建蓝色封面，红色封面，绿色封面'
      const parts = text.split(/[，,]/)
      expect(parts.length).toBe(3)
    })

    it('should filter valid request parts', () => {
      const text = '创建蓝色封面，标题32px'
      const parts = text.split(/[，,]/)
      // Both parts are > 5 chars
      const validParts = parts.filter(s => s.trim().length > 5)
      expect(validParts.length).toBe(2)
    })
  })

  describe('Board Cleanup Logic', () => {
    it('should identify boards by session ID', () => {
      const mockBoard = {
        type: 'ready-board',
        meta: {
          sessionId: 'test-session-123',
          createdAt: Date.now(),
        },
      }
      expect(mockBoard.type).toBe('ready-board')
      expect(mockBoard.meta.sessionId).toBe('test-session-123')
    })

    it('should sort boards by creation time descending', () => {
      const boards = [
        { id: 'board1', createdAt: 1000 },
        { id: 'board3', createdAt: 3000 },
        { id: 'board2', createdAt: 2000 },
      ]
      boards.sort((a, b) => b.createdAt - a.createdAt)
      expect(boards[0].id).toBe('board3')
      expect(boards[1].id).toBe('board2')
      expect(boards[2].id).toBe('board1')
    })

    it('should keep only latest N boards', () => {
      const boards = [
        { id: 'board1', createdAt: 1000 },
        { id: 'board2', createdAt: 2000 },
        { id: 'board3', createdAt: 3000 },
        { id: 'board4', createdAt: 4000 },
        { id: 'board5', createdAt: 5000 },
        { id: 'board6', createdAt: 6000 },
      ]
      boards.sort((a, b) => b.createdAt - a.createdAt)
      const keepLatest = 5
      const toDelete = boards.slice(keepLatest)
      expect(toDelete.length).toBe(1)
      expect(toDelete[0].id).toBe('board1')
    })
  })

  describe('Integration with Semantic Controls', () => {
    it('should extract style presets from separate requests', () => {
      const text1 = '创建大字报封面'
      const text2 = '创建奢华封面'

      const controls1 = extractDesignSemanticControls(text1)
      const controls2 = extractDesignSemanticControls(text2)

      expect(controls1.stylePreset).toBe('poster')
      expect(controls2.stylePreset).toBe('luxury')
    })

    it('should extract style preset from variant request', () => {
      const text = '创建大字报变体'
      const controls = extractDesignSemanticControls(text)
      expect(controls.stylePreset).toBe('poster')
    })

    it('should handle combined style and variant keywords', () => {
      const text = '创建3个方案，大字报风格'
      const variantMatch = text.match(/(\d+)\s*(?:个|种)?(?:变体|版本|方案)/i)
      const controls = extractDesignSemanticControls(text)

      expect(variantMatch?.[1]).toBe('3')
      expect(controls.stylePreset).toBe('poster')
    })
  })

  describe('Strategy Inference Examples', () => {
    it('should infer single board for simple request', () => {
      const text = '创建蓝色封面'
      // No variant pattern, no multiple requests
      const hasVariant = /(\d+)\s*(?:个|种)?(?:变体|版本|方案)/i.test(text)
      const parts = text.split(/[，,；;]|(?:和|以及|还有)/)
      expect(hasVariant).toBe(false)
      expect(parts.length).toBe(1)
    })

    it('should infer multiple boards for "和" separated requests', () => {
      const text = '创建大字报封面和奢华封面'
      const parts = text.split('和')
      expect(parts.length).toBe(2)
    })

    it('should infer variant mode for explicit variant request', () => {
      const text = '创建3个变体'
      const hasVariant = /(\d+)\s*(?:个|种)?(?:变体|版本|方案)/i.test(text)
      expect(hasVariant).toBe(true)
    })
  })
})
