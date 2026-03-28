# PDF 预览功能测试指南

> 测试版本: Ready 0.1.0
> 更新时间: 2026-03-14 20:20

## 快速测试

### 1. 准备测试文件

创建或准备以下 PDF 文件：
- 小文件（< 1MB）- 快速测试
- 中等文件（1-10MB）- 常规测试
- 大文件（10-50MB）- 性能测试
- 包含中文路径的文件 - 编码测试

### 2. 启动应用

```bash
npm run dev
```

### 3. 测试步骤

#### 基础功能测试

1. **打开 PDF 文件**
   - 在文件树中找到 PDF 文件
   - 双击打开
   - ✅ 应该显示加载动画
   - ✅ 应该正常显示 PDF 内容

2. **缩放功能**
   - 点击 "+" 按钮放大
   - 点击 "-" 按钮缩小
   - 点击百分比重置为 100%
   - 点击适应宽度按钮
   - ✅ 缩放应该流畅

3. **翻页功能**
   - 点击上/下箭头翻页
   - 滚动鼠标翻页
   - ✅ 页码应该正确更新

4. **快捷键**
   - Ctrl/Cmd + 滚轮缩放
   - ✅ 应该正常工作

#### 错误处理测试

1. **无效文件**
   - 尝试打开损坏的 PDF
   - ✅ 应该显示错误信息

2. **大文件**
   - 打开超大 PDF（>50MB）
   - ✅ 应该显示加载进度或警告

3. **网络中断**
   - 打开文件后断开网络
   - ✅ 已加载的 PDF 应该继续可用

#### 性能测试

1. **加载速度**
   - 记录小文件加载时间
   - ✅ 应该 < 1 秒

2. **内存使用**
   - 打开多个 PDF
   - 检查内存使用
   - ✅ 应该合理（每个文件约等于文件大小）

3. **切换速度**
   - 在多个 PDF 标签间切换
   - ✅ 应该即时响应

## 详细测试清单

### 功能测试

- [ ] 打开 PDF 文件
- [ ] 显示加载动画
- [ ] 正确显示 PDF 内容
- [ ] 显示页码（当前页/总页数）
- [ ] 放大功能
- [ ] 缩小功能
- [ ] 重置缩放
- [ ] 适应宽度
- [ ] 上一页
- [ ] 下一页
- [ ] 滚动翻页
- [ ] Ctrl/Cmd + 滚轮缩放
- [ ] 多页 PDF 正确显示
- [ ] 文本选择（如果启用）
- [ ] 链接点击（如果有）

### 错误处理

- [ ] 损坏的 PDF 显示错误
- [ ] 不存在的文件显示错误
- [ ] 权限不足显示错误
- [ ] 错误信息清晰易懂

### 性能测试

- [ ] 小文件（< 1MB）加载 < 1 秒
- [ ] 中等文件（1-10MB）加载 < 3 秒
- [ ] 大文件（10-50MB）加载 < 10 秒
- [ ] 内存使用合理
- [ ] 无内存泄漏
- [ ] 切换标签流畅

### 兼容性测试

- [ ] macOS 正常工作
- [ ] Windows 正常工作（待测试）
- [ ] Linux 正常工作（待测试）
- [ ] 不同路径格式正常
- [ ] 中文路径正常
- [ ] 特殊字符路径正常

### UI/UX 测试

- [ ] 工具栏布局合理
- [ ] 按钮图标清晰
- [ ] 加载状态明显
- [ ] 错误提示友好
- [ ] 缩放比例显示清晰
- [ ] 页码显示清晰

## 常见问题排查

### 问题 1: PDF 不显示

**检查**:
1. 打开开发者工具（F12）
2. 查看 Console 标签
3. 查看 Network 标签

**可能原因**:
- 文件路径错误
- 协议处理器未正确配置
- PDF 文件损坏
- 权限问题

**解决方法**:
```typescript
// 检查 fileUrl
console.log('PDF URL:', fileUrl)

// 检查 fetch 响应
const response = await fetch(fileUrl)
console.log('Response status:', response.status)
console.log('Response headers:', response.headers)
```

### 问题 2: 加载很慢

**检查**:
1. 文件大小
2. 网络请求时间
3. 内存使用

**可能原因**:
- 文件太大
- 磁盘 I/O 慢
- 内存不足

**解决方法**:
- 添加文件大小限制
- 显示加载进度
- 优化内存使用

### 问题 3: 缩放不流畅

**检查**:
1. CPU 使用率
2. GPU 使用率
3. 渲染性能

**可能原因**:
- PDF 页面复杂
- 缩放比例过大
- 硬件性能不足

**解决方法**:
- 限制最大缩放比例
- 使用虚拟滚动
- 优化渲染

## 自动化测试

### 单元测试

```typescript
// tests/PdfViewer.test.tsx
import { render, waitFor } from '@testing-library/react'
import PdfViewer from '../PdfViewer'

test('loads PDF successfully', async () => {
  const { getByText } = render(
    <PdfViewer tab={{ path: '/test.pdf' }} fileUrl="local-file:///test.pdf" />
  )

  await waitFor(() => {
    expect(getByText(/1 \/ \d+/)).toBeInTheDocument()
  })
})

test('shows error on invalid PDF', async () => {
  const { getByText } = render(
    <PdfViewer tab={{ path: '/invalid.pdf' }} fileUrl="local-file:///invalid.pdf" />
  )

  await waitFor(() => {
    expect(getByText(/加载失败/)).toBeInTheDocument()
  })
})
```

### 集成测试

```typescript
// tests/integration/pdf-preview.test.ts
import { test, expect } from '@playwright/test'

test('PDF preview works end-to-end', async ({ page }) => {
  await page.goto('/')

  // 打开文件树
  await page.click('[data-testid="file-tree"]')

  // 选择 PDF 文件
  await page.click('text=test.pdf')

  // 等待加载
  await page.waitForSelector('[data-testid="pdf-viewer"]')

  // 验证显示
  const pageNumber = await page.textContent('[data-testid="page-number"]')
  expect(pageNumber).toMatch(/1 \/ \d+/)
})
```

## 性能基准

### 目标性能

| 文件大小 | 加载时间 | 内存使用 |
|---------|---------|---------|
| < 1MB   | < 1s    | < 10MB  |
| 1-10MB  | < 3s    | < 50MB  |
| 10-50MB | < 10s   | < 200MB |

### 测量方法

```typescript
// 加载时间
const startTime = performance.now()
await loadPdf()
const loadTime = performance.now() - startTime
console.log(`Load time: ${loadTime}ms`)

// 内存使用
if (performance.memory) {
  console.log(`Memory used: ${performance.memory.usedJSHeapSize / 1024 / 1024}MB`)
}
```

## 回归测试

每次修改后运行：

1. **基础功能**
   - [ ] 打开 PDF
   - [ ] 缩放
   - [ ] 翻页

2. **错误处理**
   - [ ] 无效文件
   - [ ] 权限错误

3. **性能**
   - [ ] 加载速度
   - [ ] 内存使用

## 测试报告模板

```markdown
# PDF 预览测试报告

**测试日期**: YYYY-MM-DD
**测试人**: 姓名
**测试环境**: macOS/Windows/Linux
**应用版本**: 0.1.0

## 测试结果

### 功能测试
- 打开 PDF: ✅/❌
- 缩放: ✅/❌
- 翻页: ✅/❌
- ...

### 性能测试
- 小文件加载: Xs
- 中等文件加载: Xs
- 大文件加载: Xs

### 问题列表
1. 问题描述
   - 重现步骤
   - 预期结果
   - 实际结果
   - 截图

## 总结
- 通过: X/Y
- 失败: X/Y
- 阻塞问题: X
```

## 持续监控

### 日志监控

```bash
# 查看 PDF 相关日志
tail -f /tmp/ready-directchat.log | grep -i pdf
```

### 性能监控

```typescript
// 添加性能监控
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.name.includes('pdf')) {
      console.log(`${entry.name}: ${entry.duration}ms`)
    }
  }
})
observer.observe({ entryTypes: ['measure'] })
```

### 错误监控

```typescript
// 添加错误监控
window.addEventListener('error', (event) => {
  if (event.message.includes('pdf')) {
    console.error('PDF Error:', event.error)
    // 发送到错误追踪服务
  }
})
```

---

**维护者**: Ready 开发团队
**最后更新**: 2026-03-14
**下次审查**: 2026-04-14
