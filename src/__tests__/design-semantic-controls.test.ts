import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractDesignSemanticControls } from '../shared/design-agent'

describe('extractDesignSemanticControls', () => {
  describe('圆角控制', () => {
    it('应该提取具体圆角值', () => {
      const result = extractDesignSemanticControls('创建一个圆角 16px 的卡片')
      assert.equal(result.explicitCornerRadius, 16)
    })

    it('应该识别无圆角', () => {
      const result = extractDesignSemanticControls('创建一个无圆角的卡片')
      assert.equal(result.cornerRadiusScale, 0)
    })

    it('应该识别圆角更大', () => {
      const result = extractDesignSemanticControls('创建一个圆角更大的卡片')
      assert.equal(result.cornerRadiusScale, 1.3)
    })

    it('应该识别圆角更小', () => {
      const result = extractDesignSemanticControls('创建一个圆角小一点的卡片')
      assert.equal(result.cornerRadiusScale, 0.7)
    })
  })

  describe('字号控制', () => {
    it('应该提取标题字号', () => {
      const result = extractDesignSemanticControls('创建标题 32px 的文本块')
      assert.equal(result.explicitTitleFontSize, 32)
    })

    it('应该提取正文字号', () => {
      const result = extractDesignSemanticControls('创建正文 14px 的文本块')
      assert.equal(result.explicitBodyFontSize, 14)
    })
  })

  describe('行高控制', () => {
    it('应该提取行高', () => {
      const result = extractDesignSemanticControls('创建行高 1.5 的文本块')
      assert.equal(result.explicitLineHeight, 1.5)
    })
  })

  describe('字重控制', () => {
    it('应该识别粗体', () => {
      const result = extractDesignSemanticControls('创建粗体标题')
      assert.equal(result.fontWeightMode, 'bold')
    })

    it('应该识别细体', () => {
      const result = extractDesignSemanticControls('创建细体正文')
      assert.equal(result.fontWeightMode, 'light')
    })

    it('应该识别 medium', () => {
      const result = extractDesignSemanticControls('创建中等字重的标题')
      assert.equal(result.fontWeightMode, 'medium')
    })

    it('应该识别 black', () => {
      const result = extractDesignSemanticControls('创建特粗标题')
      assert.equal(result.fontWeightMode, 'black')
    })
  })

  describe('间距控制', () => {
    it('应该识别间距更大', () => {
      const result = extractDesignSemanticControls('创建间距更大的卡片')
      assert.equal(result.spacingScale, 1.3)
    })

    it('应该识别更紧凑', () => {
      const result = extractDesignSemanticControls('创建更紧凑的布局')
      assert.equal(result.spacingScale, 0.7)
    })
  })

  describe('对齐控制', () => {
    it('应该识别居中对齐', () => {
      const result = extractDesignSemanticControls('创建居中对齐的标题')
      assert.equal(result.alignMode, 'center')
    })

    it('应该识别左对齐', () => {
      const result = extractDesignSemanticControls('创建左对齐的标题')
      assert.equal(result.alignMode, 'left')
    })

    it('应该识别右对齐', () => {
      const result = extractDesignSemanticControls('创建右对齐的标题')
      assert.equal(result.alignMode, 'right')
    })
  })

  describe('组合控制', () => {
    it('应该同时提取多个控制', () => {
      const result = extractDesignSemanticControls(
        '创建一个圆角 8px、标题 32px、粗体、居中对齐、间距更大的卡片'
      )
      assert.equal(result.explicitCornerRadius, 8)
      assert.equal(result.explicitTitleFontSize, 32)
      assert.equal(result.fontWeightMode, 'bold')
      assert.equal(result.alignMode, 'center')
      assert.equal(result.spacingScale, 1.3)
    })
  })

  describe('向后兼容', () => {
    it('应该保留现有字段的默认值', () => {
      const result = extractDesignSemanticControls('创建一个简单的卡片')
      assert.equal(result.titleScale, 1)
      assert.equal(result.bodyScale, 1)
      assert.equal(result.sectionScale, 1)
      assert.equal(result.prefersSparseContent, false)
      assert.equal(result.prefersLargeElements, false)
      assert.equal(result.cornerRadiusScale, 1.0)
      assert.equal(result.spacingScale, 1.0)
    })
  })
})
