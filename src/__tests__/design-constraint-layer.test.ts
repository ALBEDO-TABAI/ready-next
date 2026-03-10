import { describe, it, expect } from 'vitest'
import { extractDesignSemanticControls } from '../shared/design-agent'

describe('Design Constraint Layer - Stage 3A & 3B', () => {
  describe('Stage 3A: Board Size Awareness', () => {
    it('should recognize font size constraints', () => {
      const controls = extractDesignSemanticControls('创建 500x500 的封面，标题 32px')
      expect(controls.explicitTitleFontSize).toBe(32)
    })

    it('should recognize corner radius values', () => {
      const controls = extractDesignSemanticControls('创建圆角 16px 的卡片')
      expect(controls.explicitCornerRadius).toBe(16)
    })

    it('should recognize contrast accent preference', () => {
      const controls = extractDesignSemanticControls('创建加一点对色的封面')
      expect(controls.prefersContrastAccent).toBe(true)
    })
  })

  describe('Stage 3B: Style Presets', () => {
    it('should recognize poster style', () => {
      const controls = extractDesignSemanticControls('创建大字报封面')
      expect(controls.stylePreset).toBe('poster')
      expect(controls.titleScale).toBeGreaterThan(2)
      expect(controls.prefersSparseContent).toBe(true)
    })

    it('should recognize luxury style', () => {
      const controls = extractDesignSemanticControls('创建奢华风格的封面')
      expect(controls.stylePreset).toBe('luxury')
      expect(controls.cornerRadiusScale).toBeLessThan(0.5)
      expect(controls.prefersContrastAccent).toBe(true)
    })

    it('should recognize minimal style', () => {
      const controls = extractDesignSemanticControls('创建极简封面')
      expect(controls.stylePreset).toBe('minimal')
      expect(controls.cornerRadiusScale).toBe(0)
      expect(controls.spacingScale).toBeGreaterThan(1.5)
    })

    it('should recognize editorial style', () => {
      const controls = extractDesignSemanticControls('创建编辑风格的封面')
      expect(controls.stylePreset).toBe('editorial')
      expect(controls.titleScale).toBeGreaterThan(1.5)
      expect(controls.prefersContrastAccent).toBe(true)
    })

    it('should recognize tech style', () => {
      const controls = extractDesignSemanticControls('创建科技风格的封面')
      expect(controls.stylePreset).toBe('tech')
      expect(controls.cornerRadiusScale).toBeGreaterThan(1.3)
      expect(controls.prefersLargeElements).toBe(true)
    })

    it('should recognize organic style', () => {
      const controls = extractDesignSemanticControls('创建有机风格的封面')
      expect(controls.stylePreset).toBe('organic')
      expect(controls.cornerRadiusScale).toBeGreaterThan(1)
      expect(controls.prefersContrastAccent).toBe(true)
    })

    it('should allow explicit parameters to override preset', () => {
      const controls = extractDesignSemanticControls('创建大字报封面，圆角 20px')
      expect(controls.stylePreset).toBe('poster')
      expect(controls.explicitCornerRadius).toBe(20)
      // Explicit corner radius should override preset's cornerRadiusScale
    })

    it('should handle no style preset', () => {
      const controls = extractDesignSemanticControls('创建蓝色封面')
      expect(controls.stylePreset).toBeNull()
      expect(controls.titleScale).toBe(1)
    })
  })

  describe('Stage 3A: Contrast Accent Strategy', () => {
    it('should prefer contrast in sparse layouts', () => {
      const controls = extractDesignSemanticControls('创建加一点对色的封面，信息更少')
      expect(controls.prefersContrastAccent).toBe(true)
      expect(controls.prefersSparseContent).toBe(true)
    })

    it('should prefer contrast in dense layouts', () => {
      const controls = extractDesignSemanticControls('创建加一点对色的封面，密集')
      expect(controls.prefersContrastAccent).toBe(true)
      expect(controls.prefersSparseContent).toBe(false)
    })
  })

  describe('Combined Scenarios', () => {
    it('should handle poster style with explicit font size', () => {
      const controls = extractDesignSemanticControls('创建大字报封面，标题 48px')
      expect(controls.stylePreset).toBe('poster')
      expect(controls.explicitTitleFontSize).toBe(48)
      expect(controls.prefersSparseContent).toBe(true)
    })

    it('should handle luxury style with contrast accent', () => {
      const controls = extractDesignSemanticControls('创建奢华风格的封面，加一点对色')
      expect(controls.stylePreset).toBe('luxury')
      expect(controls.prefersContrastAccent).toBe(true)
    })

    it('should handle minimal style with center alignment', () => {
      const controls = extractDesignSemanticControls('创建极简封面，居中')
      expect(controls.stylePreset).toBe('minimal')
      expect(controls.alignMode).toBe('center')
    })
  })
})
