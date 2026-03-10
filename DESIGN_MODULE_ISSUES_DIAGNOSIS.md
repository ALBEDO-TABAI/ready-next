# Ready 设计模块问题诊断报告

> 诊断时间: 2026-03-10
> 基于用户反馈和截图分析

## 问题概述

从用户提供的截图和反馈来看，虽然完成了语义控制的基础架构，但在实际使用中暴露了多个根本性问题：

## 核心问题清单

### 1. 字号与画板比例约束缺失 ❌

**问题描述**:
- 用户指定"标题 32px"等具体字号时，没有考虑画板尺寸的约束
- 500x500 的小画板和 1920x1080 的大画板使用相同字号会导致比例失调

**根本原因**:
```typescript
// 当前实现（design-agent-handler.ts:1398-1402）
titleFontSize: clampRound(
  semanticControls.explicitTitleFontSize  // 直接使用用户指定的字号
    ?? Number(source.titleFontSize ?? Math.round(defaults.titleFontSize * semanticControls.titleScale)),
  20, 52  // 固定的上下限，不考虑画板尺寸
),
```

**问题**:
- `explicitTitleFontSize` 直接应用，没有根据画板尺寸调整
- clamp 的上下限（20-52）是固定的，不随画板尺寸变化
- 缺少"字号/画板高度"的比例约束

**影响**:
- 小画板（500x500）使用 32px 字号会显得过大
- 大画板（1920x1080）使用 32px 字号会显得过小
- 无法保证视觉平衡

### 2. "对色"（contrastAccent）未真正实现 ❌

**问题描述**:
- 用户要求"加一点对色"，但实际效果不明显或未生效

**当前实现**:
```typescript
// design-agent-handler.ts:4911-4913
const accentColor = semanticControls.prefersContrastAccent && params.styleSystem.palette.contrastAccent
  ? params.styleSystem.palette.contrastAccent
  : params.styleSystem.palette.accent
```

**问题**:
1. **提取逻辑存在但应用有限**:
   - `prefersContrastAccent` 能正确识别"对色"、"撞色"等关键词
   - 但只在少数地方应用（ornament、footer）
   - 主要内容区域（标题、section）没有应用对色

2. **对色应用范围太窄**:
   - 只在 ornament（装饰元素）和 footer 使用
   - 标题、副标题、section 卡片等主要元素没有对色选项

3. **缺少对色策略**:
   - 没有定义哪些元素应该使用对色
   - 没有对色面积比例控制（通常对色应占 10-20%）

**影响**:
- 用户要求"加一点对色"时，视觉效果不明显
- 对色只出现在装饰元素，主要内容区域单调

### 3. 圆角使用缺少设计规范 ❌

**问题描述**:
- 用户可以指定任意圆角值，但缺少设计规范约束
- 不同元素的圆角关系混乱

**当前实现**:
```typescript
// design-agent-handler.ts:1324-1328
cornerRadius: clampRound(
  semanticControls.explicitCornerRadius
    ?? Number(source.cornerRadius ?? Math.round(baseCornerRadius * semanticControls.cornerRadiusScale)),
  0, 40  // 允许 0-40px 的任意值
),
```

**问题**:
1. **缺少圆角层级系统**:
   - 没有定义 board、card、chip 之间的圆角关系
   - 应该有：board > card > chip 的递减关系
   - 例如：board=24, card=16, chip=12

2. **缺少圆角与尺寸的关系**:
   - 小元素（chip）不应该有大圆角
   - 大元素（board）的圆角应该与尺寸成比例

3. **缺少圆角风格约束**:
   - 没有预设的圆角风格（sharp=0-4, soft=8-16, round=20-32）
   - 用户指定"圆角 8px"时，所有元素都用 8px，缺少层级

**影响**:
- 圆角使用不一致，缺少设计系统感
- 小元素可能有过大的圆角，大元素可能有过小的圆角

### 4. "大字报"风格未实现 ❌

**问题描述**:
- 用户要求"大字报封面排版"，但系统没有识别和实现这种风格

**根本原因**:
1. **缺少"大字报"风格的语义识别**:
   ```typescript
   // 当前 extractDesignSemanticControls 没有识别"大字报"
   // 应该添加：
   const prefersBigPoster = /(大字报|超大标题|巨大字体)/i.test(rawText)
   ```

2. **缺少"大字报"风格的参数映射**:
   - 大字报 = 超大标题（titleScale > 2.0）+ 极简内容（只有标题）
   - 应该自动设置：
     - `titleScale = 2.5`
     - `prefersSparseContent = true`
     - `sectionCount = 0`（无 section）

3. **缺少风格预设系统**:
   - 应该有预定义的风格：editorial、poster、minimal、luxury 等
   - 每种风格有对应的参数组合

**影响**:
- 用户要求"大字报"时，系统按普通封面处理
- 标题不够大，内容不够简洁

### 5. 多画板生成逻辑错误 ❌

**问题描述**:
- 用户要求"大字报"和"奢华"两个需求，系统生成了 4 个画板

**根本原因**:
```typescript
// 当前配置（从日志推断）
allowMultipleDesignArtifacts=false
```

**问题**:
1. **会话状态管理混乱**:
   - 每次请求应该是独立的，但可能复用了之前的画板
   - 没有清理之前的设计结果

2. **画板创建逻辑不清晰**:
   - 应该明确：一次请求 = 一个画板
   - 除非用户明确要求"生成 3 个变体"

3. **缺少画板管理策略**:
   - 新请求是覆盖当前画板还是创建新画板？
   - 如何处理画板的命名和组织？

**影响**:
- 画板数量失控，用户困惑
- 画布变得混乱，难以管理

## 根本性架构问题

### A. 缺少设计系统约束层

**问题**: 当前实现是"自由参数"模式，缺少设计系统的约束和规范。

**应该有的层次**:
```
用户输入（自然语言）
    ↓
语义提取（当前已实现）
    ↓
设计系统约束层（缺失！）← 这一层缺失
    ↓
参数应用（当前已实现）
    ↓
设计生成
```

**设计系统约束层应该包含**:
1. **比例约束**: 字号/画板高度 应在 0.03-0.08 之间
2. **层级约束**: board圆角 > card圆角 > chip圆角
3. **面积约束**: 对色面积应占 10-20%
4. **风格预设**: poster、editorial、luxury 等预定义组合

### B. 缺少风格识别和映射

**问题**: 只识别单个属性（圆角、字号），不识别整体风格（大字报、奢华）。

**应该添加**:
```typescript
interface DesignStylePreset {
  name: string  // 'poster', 'luxury', 'minimal'
  titleScale: number
  bodyScale: number
  cornerRadiusScale: number
  spacingScale: number
  prefersSparseContent: boolean
  prefersContrastAccent: boolean
  // ... 其他参数
}

const STYLE_PRESETS: Record<string, DesignStylePreset> = {
  'poster': {
    name: '大字报',
    titleScale: 2.5,
    bodyScale: 0.8,
    cornerRadiusScale: 0.5,
    spacingScale: 1.5,
    prefersSparseContent: true,
    prefersContrastAccent: false,
  },
  'luxury': {
    name: '奢华',
    titleScale: 1.3,
    bodyScale: 1.0,
    cornerRadiusScale: 0.3,  // 小圆角或直角
    spacingScale: 1.4,
    prefersSparseContent: true,
    prefersContrastAccent: true,  // 金色对色
  },
  // ...
}
```

### C. 缺少画板尺寸感知

**问题**: 所有参数都是绝对值或固定比例，不根据画板尺寸调整。

**应该添加**:
```typescript
function adjustForBoardSize(
  baseValue: number,
  boardWidth: number,
  boardHeight: number,
  type: 'fontSize' | 'spacing' | 'cornerRadius'
): number {
  const boardArea = boardWidth * boardHeight
  const referenceArea = 540 * 960  // 9:16 参考尺寸
  const sizeRatio = Math.sqrt(boardArea / referenceArea)

  switch (type) {
    case 'fontSize':
      // 字号随画板尺寸线性缩放
      return Math.round(baseValue * sizeRatio)
    case 'spacing':
      // 间距随画板尺寸缩放，但增长较慢
      return Math.round(baseValue * Math.pow(sizeRatio, 0.8))
    case 'cornerRadius':
      // 圆角随画板尺寸缩放，但增长更慢
      return Math.round(baseValue * Math.pow(sizeRatio, 0.6))
  }
}
```

## 修复优先级

### P0 - 立即修复（阻断问题）

1. **字号与画板比例约束**
   - 添加 `adjustForBoardSize` 函数
   - 修改 typography 生成逻辑，应用尺寸调整
   - 添加字号/画板高度比例检查

2. **画板创建逻辑**
   - 明确一次请求 = 一个画板
   - 添加画板清理逻辑

### P1 - 高优先级（影响体验）

3. **"对色"完整实现**
   - 扩展对色应用范围（标题、section）
   - 添加对色面积控制
   - 添加对色策略（哪些元素用对色）

4. **风格预设系统**
   - 添加"大字报"、"奢华"等风格识别
   - 实现风格到参数的映射
   - 添加风格预设库

### P2 - 中优先级（完善功能）

5. **圆角设计规范**
   - 添加圆角层级系统
   - 添加圆角与尺寸的关系
   - 添加圆角风格预设

6. **设计系统约束层**
   - 添加比例约束检查
   - 添加层级约束检查
   - 添加面积约束检查

## 建议的修复方案

### 方案 1: 快速修复（1-2 天）

只修复 P0 问题：
- 添加画板尺寸感知
- 修复画板创建逻辑

**优点**: 快速见效，解决最严重的问题
**缺点**: 不解决根本问题，后续还需要大改

### 方案 2: 完整重构（3-5 天）

修复 P0 + P1 + P2：
- 添加设计系统约束层
- 实现风格预设系统
- 完善对色和圆角规范

**优点**: 一次性解决根本问题，建立完整的设计系统
**缺点**: 工作量大，需要更多时间

### 方案 3: 分阶段修复（推荐）

**第一阶段（1-2 天）**: P0 问题
- 画板尺寸感知
- 画板创建逻辑

**第二阶段（2-3 天）**: P1 问题
- 对色完整实现
- 风格预设系统

**第三阶段（1-2 天）**: P2 问题
- 圆角规范
- 约束层

**优点**: 平衡速度和质量，逐步改进
**缺点**: 需要分多次部署

## 结论

当前的语义控制实现只完成了"提取"和"应用"两个环节，但缺少了最关键的"约束"和"规范"环节。这导致：

1. ❌ 参数可以自由设置，但缺少设计系统的约束
2. ❌ 只识别单个属性，不识别整体风格
3. ❌ 不考虑画板尺寸，导致比例失调
4. ❌ 对色、圆角等功能实现不完整

**建议**: 采用方案 3（分阶段修复），先解决最严重的比例问题，再逐步完善设计系统。
