import { describe, it, expect } from 'vitest'
import { extractDesignSemanticControls } from '../shared/design-agent'

describe('Design Enhanced Semantic Controls - Stage 3D', () => {
  describe('Color Control', () => {
    it('should extract explicit background color (hex)', () => {
      const intent = '创建封面，背景色 #FF5733'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBackgroundColor).toBe('#FF5733')
    })

    it('should extract explicit accent color (hex)', () => {
      const intent = '创建封面，强调色 #2FB7A8'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitAccentColor).toBe('#2FB7A8')
    })

    it('should extract explicit text color (hex)', () => {
      const intent = '创建封面，文字颜色 #FFFFFF'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitTextColor).toBe('#FFFFFF')
    })

    it('should extract 3-digit hex colors', () => {
      const intent = '创建封面，背景色 #F00'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBackgroundColor).toBe('#F00')
    })

    it('should handle multiple color specifications', () => {
      const intent = '创建封面，背景色 #0D1117，强调色 #2F81F7，文字颜色 #E6EDF3'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBackgroundColor).toBe('#0D1117')
      expect(controls.explicitAccentColor).toBe('#2F81F7')
      expect(controls.explicitTextColor).toBe('#E6EDF3')
    })

    it('should return null when no explicit colors', () => {
      const intent = '创建蓝色封面'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBackgroundColor).toBeNull()
      expect(controls.explicitAccentColor).toBeNull()
      expect(controls.explicitTextColor).toBeNull()
    })
  })

  describe('Border Control', () => {
    it('should extract explicit border width', () => {
      const intent = '创建封面，边框 2px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderWidth).toBe(2)
    })

    it('should extract border width without px unit', () => {
      const intent = '创建封面，边框 4'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderWidth).toBe(4)
    })

    it('should extract solid border style', () => {
      const intent = '创建封面，实线边框'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderStyle).toBe('solid')
    })

    it('should extract dashed border style', () => {
      const intent = '创建封面，虚线边框'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderStyle).toBe('dashed')
    })

    it('should extract dotted border style', () => {
      const intent = '创建封面，点线边框'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderStyle).toBe('dotted')
    })

    it('should extract both border width and style', () => {
      const intent = '创建封面，边框 2px 虚线'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderWidth).toBe(2)
      expect(controls.explicitBorderStyle).toBe('dashed')
    })

    it('should return null when no explicit border', () => {
      const intent = '创建封面'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderWidth).toBeNull()
      expect(controls.explicitBorderStyle).toBeNull()
    })
  })

  describe('Precise Spacing Control', () => {
    it('should extract explicit padding', () => {
      const intent = '创建封面，内边距 24px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitPadding).toBe(24)
    })

    it('should extract padding without px unit', () => {
      const intent = '创建封面，padding 32'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitPadding).toBe(32)
    })

    it('should extract explicit gap', () => {
      const intent = '创建封面，间隙 16px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitGap).toBe(16)
    })

    it('should extract gap without px unit', () => {
      const intent = '创建封面，gap 20'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitGap).toBe(20)
    })

    it('should extract both padding and gap', () => {
      const intent = '创建封面，内边距 24px，间隙 16px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitPadding).toBe(24)
      expect(controls.explicitGap).toBe(16)
    })

    it('should return null when no explicit spacing', () => {
      const intent = '创建封面'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitPadding).toBeNull()
      expect(controls.explicitGap).toBeNull()
    })
  })

  describe('Integration with Existing Controls', () => {
    it('should work with style presets', () => {
      const intent = '创建大字报封面，背景色 #FF5733，边框 2px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.stylePreset).toBe('poster')
      expect(controls.explicitBackgroundColor).toBe('#FF5733')
      expect(controls.explicitBorderWidth).toBe(2)
    })

    it('should work with existing semantic controls', () => {
      const intent = '创建封面，标题 48px，圆角 16px，背景色 #0D1117，边框 2px 虚线'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitTitleFontSize).toBe(48)
      expect(controls.explicitCornerRadius).toBe(16)
      expect(controls.explicitBackgroundColor).toBe('#0D1117')
      expect(controls.explicitBorderWidth).toBe(2)
      expect(controls.explicitBorderStyle).toBe('dashed')
    })

    it('should work with spacing scale and explicit spacing', () => {
      const intent = '创建封面，间距更大，内边距 32px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.spacingScale).toBe(1.3)
      expect(controls.explicitPadding).toBe(32)
    })

    it('should handle complex combined controls', () => {
      const intent = '创建奢华封面，背景色 #140F19，强调色 #A371F7，文字颜色 #F2EAFE，边框 1px 实线，内边距 40px，间隙 24px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.stylePreset).toBe('luxury')
      expect(controls.explicitBackgroundColor).toBe('#140F19')
      expect(controls.explicitAccentColor).toBe('#A371F7')
      expect(controls.explicitTextColor).toBe('#F2EAFE')
      expect(controls.explicitBorderWidth).toBe(1)
      expect(controls.explicitBorderStyle).toBe('solid')
      expect(controls.explicitPadding).toBe(40)
      expect(controls.explicitGap).toBe(24)
    })
  })

  describe('Priority and Override', () => {
    it('should allow explicit colors to override style preset colors', () => {
      const intent = '创建科技封面，背景色 #FF0000'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.stylePreset).toBe('tech')
      expect(controls.explicitBackgroundColor).toBe('#FF0000')
    })

    it('should allow explicit spacing to override spacing scale', () => {
      const intent = '创建封面，间距更大，内边距 16px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.spacingScale).toBe(1.3)
      expect(controls.explicitPadding).toBe(16)
    })
  })

  describe('Edge Cases', () => {
    it('should handle zero values', () => {
      const intent = '创建封面，边框 0px，内边距 0'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBorderWidth).toBe(0)
      expect(controls.explicitPadding).toBe(0)
    })

    it('should handle large values', () => {
      const intent = '创建封面，内边距 100px，间隙 80px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitPadding).toBe(100)
      expect(controls.explicitGap).toBe(80)
    })

    it('should handle English keywords', () => {
      const intent = 'Create cover with background #FF5733, border 2px dashed, padding 24px'
      const controls = extractDesignSemanticControls(intent)

      expect(controls.explicitBackgroundColor).toBe('#FF5733')
      expect(controls.explicitBorderWidth).toBe(2)
      expect(controls.explicitBorderStyle).toBe('dashed')
      expect(controls.explicitPadding).toBe(24)
    })
  })
})
