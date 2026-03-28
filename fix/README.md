# Ready 项目跨平台兼容性修复文档索引

> 创建时间: 2026-03-14
> 维护者: Ready 开发团队

## 📚 文档概览

本目录包含 Ready 项目跨平台兼容性问题的诊断、修复和最佳实践文档。

## 📖 文档列表

### 1. [跨平台问题诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md)

**完整的问题诊断和修复指南**

涵盖内容：
- 硬编码路径问题
- PATH 环境变量分隔符问题
- 命令行工具平台差异
- 文件路径与 URL 转换问题
- 文件协议 CORS 问题
- 安全检查过于严格
- Mock 服务配置问题
- 渲染进程路径显示问题

适合：
- 深入了解问题根源
- 学习完整的修复方案
- 作为培训材料

### 2. [快速参考指南](./quick-reference.md)

**日常开发快速查阅手册**

涵盖内容：
- 常见错误和正确做法对比
- 代码片段和示例
- 工具函数库
- 开发检查清单
- 常见错误排查

适合：
- 日常开发参考
- 代码审查
- 快速查找解决方案

### 3. [PDF 预览 CORS 修复](./pdf-preview-cors-fix.md)

**PDF 预览问题初步分析**（已过时，见最终修复）

涵盖内容：
- 问题描述和根本原因
- CORS 技术细节
- 初步解决方案
- 安全考虑

适合：
- 理解 CORS 配置
- 历史参考

### 4. [PDF 预览最终修复](./pdf-preview-final-fix.md)

**PDF 预览问题完整解决方案**（推荐）

涵盖内容：
- 问题演进过程
- 最终解决方案（预加载数据）
- 技术原理详解
- 性能优化建议
- 最佳实践

适合：
- 解决 PDF 预览问题
- 学习文件预加载模式
- 类似问题的参考

## 🎯 快速导航

### 我遇到了问题，应该看哪个文档？

| 问题类型 | 推荐文档 | 章节 |
|---------|---------|------|
| 日志文件无法写入 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #1 硬编码路径问题 |
| Python 技能无法运行 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #2 PATH 分隔符问题 |
| ffmpeg 找不到 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #3 命令行工具差异 |
| 文件预览不工作 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #4 路径与 URL 转换 |
| PDF 无法预览 | [PDF 最终修复](./pdf-preview-final-fix.md) | 完整文档 |
| Windows 无法访问 D 盘 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #6 安全检查问题 |
| 打包后功能不可用 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #7 Mock 配置问题 |
| 文件名显示错误 | [诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md) | #8 路径显示问题 |

### 我在开发新功能，应该看哪个文档？

1. **开始前**: 阅读 [快速参考指南](./quick-reference.md) 的"永远不要做的事"部分
2. **开发中**: 使用 [快速参考指南](./quick-reference.md) 的代码片段
3. **提交前**: 检查 [快速参考指南](./quick-reference.md) 的开发检查清单

### 我在做代码审查，应该看哪个文档？

使用 [快速参考指南](./quick-reference.md) 的：
- "永远不要做的事" 部分
- "开发检查清单" 部分

## 🔧 工具和脚本

### 跨平台检查脚本

在项目根目录运行：

```bash
# 检查硬编码路径
grep -r "'/tmp/" src/ --include="*.ts" --include="*.tsx"

# 检查硬编码分隔符
grep -r '":${' src/ --include="*.ts" --include="*.tsx"

# 检查 which 命令
grep -r "'which'" src/ --include="*.ts" --include="*.tsx"

# 检查路径分割
grep -r "\.split('/')" src/ --include="*.ts" --include="*.tsx"
```

### 类型检查

```bash
npm run typecheck
```

## 📦 已创建的工具模块

### 主进程工具

**`src/main/utils/platform.ts`**
```typescript
getLogPath(filename: string): string
getTitleBarStyle(): 'default' | 'hidden' | 'hiddenInset'
getWhichCommand(): string
```

### 共享工具

**`src/shared/path-utils.ts`**
```typescript
normalizePathForUrl(filePath: string): string
pathBasename(path: string): string
pathExtension(path: string): string
```

### 渲染进程工具

**`src/renderer/utils/path.ts`**
```typescript
getFilename(path: string): string
getFileExtension(path: string): string
```

## ✅ 已修复的问题

### Phase 1: 基础设施
- ✅ 创建跨平台工具模块

### Phase 2: 日志系统
- ✅ 修复 8 个硬编码 `/tmp/` 路径

### Phase 3: 环境变量
- ✅ 修复 PATH 分隔符
- ✅ 修复 which/where 命令

### Phase 4: 文件系统
- ✅ 修复文件路径与 URL 转换
- ✅ 修复协议处理器
- ✅ 放宽安全检查

### Phase 5: 配置
- ✅ 修复 Mock 服务配置

### Phase 6: UI
- ✅ 修复渲染进程路径显示

### Phase 7: 文档
- ✅ 更新项目文档

### Phase 8: PDF 预览（最终修复）
- ✅ 添加 CORS 头（第一次尝试）
- ✅ 预加载 PDF 数据（最终方案）
- ✅ 改进错误处理
- ✅ 添加加载状态

## 🧪 测试状态

| 测试项 | macOS | Windows | 状态 |
|--------|-------|---------|------|
| 类型检查 | ✅ | - | 通过 |
| 日志写入 | ✅ | 待测试 | - |
| 文件预览 | ✅ | 待测试 | - |
| PDF 预览 | ✅ | 待测试 | - |
| 视频播放 | ✅ | 待测试 | - |
| Python 技能 | ✅ | 待测试 | - |

## 📝 待办事项

- [ ] 在 Windows 环境进行完整测试
- [ ] 验证所有文件预览功能
- [ ] 验证 Python 技能运行时
- [ ] 更新用户文档
- [ ] 创建自动化测试

## 🤝 贡献指南

### 发现新的跨平台问题？

1. 在 [诊断与修复文档](./cross-platform-issues-diagnosis-and-fixes.md) 中添加新章节
2. 更新 [快速参考指南](./quick-reference.md) 的相关部分
3. 如果是特定问题，创建专项文档（如 PDF CORS 修复）
4. 更新本索引文档

### 文档格式

- 使用 Markdown 格式
- 包含代码示例
- 说明问题、原因、解决方案
- 提供验证方法

## 📞 联系方式

如有问题或建议，请：
- 提交 Issue
- 联系开发团队
- 更新文档

## 📚 相关资源

### 官方文档
- [Node.js Path API](https://nodejs.org/api/path.html)
- [Node.js OS API](https://nodejs.org/api/os.html)
- [Electron Protocol API](https://www.electronjs.org/docs/latest/api/protocol)
- [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)

### 项目文档
- [CLAUDE.md](../CLAUDE.md) - 项目协作指引
- [DOCUMENTATION.md](../DOCUMENTATION.md) - 开发文档
- [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md) - 项目概览

---

**最后更新**: 2026-03-14
**文档版本**: 1.0.0
