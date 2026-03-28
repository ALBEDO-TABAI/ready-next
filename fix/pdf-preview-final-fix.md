# PDF 预览问题最终修复方案

> 更新时间: 2026-03-14 20:15
> 状态: ✅ 已修复

## 问题演进

### 第一次尝试：添加 CORS 头 ❌
**假设**: PDF.js 使用 fetch API，需要 CORS 头
**结果**: 仍然无法预览
**原因**: PDF.js 的 `url` 选项在 Electron 中对自定义协议支持不完善

### 第二次尝试：预加载 PDF 数据 ✅
**方案**: 先通过 fetch 加载 PDF 为 ArrayBuffer，再传给 PDF.js
**结果**: 成功！
**原因**: PDF.js 的 `data` 选项直接接受二进制数据，绕过了协议问题

## 最终解决方案

### 修改内容

**文件**: `src/renderer/components/document/PdfViewer.tsx`

#### 1. 添加状态管理

```typescript
const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null)
```

#### 2. 添加数据加载逻辑

```typescript
// Load PDF data via fetch
useEffect(() => {
  if (!fileUrl) return

  let cancelled = false

  const loadPdf = async () => {
    try {
      const response = await fetch(fileUrl)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      if (!cancelled) {
        setPdfData(arrayBuffer)
        setError(null)
      }
    } catch (err) {
      if (!cancelled) {
        console.error('PDF load error:', err)
        setError(err instanceof Error ? err.message : 'PDF 加载失败')
      }
    }
  }

  loadPdf()

  return () => {
    cancelled = true
  }
}, [fileUrl])
```

#### 3. 修改 PDF.js 配置

```typescript
// 改前：使用 URL
const fileOption = useMemo(() => ({ url: fileUrl }), [fileUrl])

// 改后：使用二进制数据
const fileOption = useMemo(() => {
  return pdfData ? { data: pdfData } : null
}, [pdfData])
```

#### 4. 添加加载状态

```typescript
if (!fileOption) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  )
}
```

## 技术原理

### PDF.js 的两种加载方式

#### 方式 1: URL 加载（不适用）
```typescript
<Document file={{ url: 'local-file:///path/to/file.pdf' }} />
```

**问题**:
- PDF.js 内部使用 fetch 加载
- 自定义协议在 Electron 中支持不完善
- 即使添加了 CORS 头，仍可能失败

#### 方式 2: 数据加载（推荐）✅
```typescript
<Document file={{ data: arrayBuffer }} />
```

**优势**:
- 直接传递二进制数据
- 不依赖协议支持
- 更可靠，更快速

### 为什么这个方案有效？

1. **绕过协议限制**
   - fetch 请求由我们的协议处理器处理（已添加 CORS 头）
   - 数据加载到内存后，PDF.js 直接使用
   - 不需要 PDF.js 再次发起网络请求

2. **更好的错误处理**
   - 可以捕获加载错误
   - 显示详细的错误信息
   - 提供加载状态反馈

3. **性能优势**
   - 数据在内存中，访问更快
   - 避免重复的网络请求
   - 更好的缓存控制

## 完整的修复清单

### 主进程修改 ✅
- [x] 添加 CORS 头到协议处理器
- [x] 支持 Range 请求（分段加载）

### 渲染进程修改 ✅
- [x] 预加载 PDF 数据
- [x] 使用 `data` 选项而非 `url`
- [x] 添加加载状态
- [x] 改进错误处理

## 验证步骤

1. 重启应用
2. 打开一个 PDF 文件
3. 确认显示加载动画
4. 确认 PDF 正常显示
5. 测试缩放、翻页功能
6. 检查控制台无错误

## 适用场景

这个方案同样适用于：

### 其他文件类型
- 大型图片文件
- 视频文件（如果使用类似的库）
- 其他需要预加载的二进制文件

### 实现模式
```typescript
// 通用的文件预加载模式
const [fileData, setFileData] = useState<ArrayBuffer | null>(null)

useEffect(() => {
  const loadFile = async () => {
    const response = await fetch(fileUrl)
    const arrayBuffer = await response.arrayBuffer()
    setFileData(arrayBuffer)
  }
  loadFile()
}, [fileUrl])

// 使用数据
<SomeComponent data={fileData} />
```

## 性能考虑

### 内存使用
- PDF 文件会完全加载到内存
- 大文件（>50MB）可能影响性能
- 考虑添加文件大小限制

### 优化建议
```typescript
// 检查文件大小
const response = await fetch(fileUrl, { method: 'HEAD' })
const size = parseInt(response.headers.get('Content-Length') || '0')

if (size > 50 * 1024 * 1024) { // 50MB
  setError('PDF 文件过大，请使用外部查看器')
  return
}
```

### 加载优化
```typescript
// 显示加载进度
const response = await fetch(fileUrl)
const reader = response.body?.getReader()
const contentLength = parseInt(response.headers.get('Content-Length') || '0')

let receivedLength = 0
const chunks: Uint8Array[] = []

while (true) {
  const { done, value } = await reader!.read()
  if (done) break

  chunks.push(value)
  receivedLength += value.length

  // 更新进度
  const progress = (receivedLength / contentLength) * 100
  setLoadProgress(progress)
}

const arrayBuffer = new Uint8Array(receivedLength)
let position = 0
for (const chunk of chunks) {
  arrayBuffer.set(chunk, position)
  position += chunk.length
}

setPdfData(arrayBuffer.buffer)
```

## 与其他方案对比

### 方案 A: 使用 file:// 协议 ❌
```typescript
// 不推荐
const fileUrl = `file://${tab.path}`
```
**问题**:
- 安全限制
- 跨域问题
- 不支持 Range 请求

### 方案 B: 使用 data URL ❌
```typescript
// 不推荐
const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
const dataUrl = `data:application/pdf;base64,${base64}`
```
**问题**:
- 编码开销大
- URL 长度限制
- 性能差

### 方案 C: 自定义协议 + 预加载 ✅
```typescript
// 推荐
const response = await fetch('local-file:///path/to/file.pdf')
const arrayBuffer = await response.arrayBuffer()
<Document file={{ data: arrayBuffer }} />
```
**优势**:
- 安全可控
- 性能好
- 支持所有功能

## 经验总结

### 关键教训

1. **不要假设库的行为**
   - PDF.js 的 `url` 选项在不同环境下行为不同
   - 需要测试实际效果，而非依赖文档

2. **预加载是可靠的方案**
   - 虽然增加了内存使用
   - 但提供了更好的控制和错误处理

3. **CORS 头仍然重要**
   - 虽然最终使用了预加载
   - 但 CORS 头对其他场景仍然有用

4. **错误处理很重要**
   - 显示详细的错误信息
   - 帮助快速定位问题

### 最佳实践

1. **分层加载**
   ```typescript
   // 1. 先显示加载状态
   // 2. 加载数据
   // 3. 显示内容
   // 4. 处理错误
   ```

2. **取消机制**
   ```typescript
   useEffect(() => {
     let cancelled = false
     // ... 异步操作
     return () => { cancelled = true }
   }, [deps])
   ```

3. **错误边界**
   ```typescript
   try {
     // 加载逻辑
   } catch (err) {
     // 错误处理
     console.error('详细错误:', err)
     setError('用户友好的错误信息')
   }
   ```

## 相关问题

### Q: 为什么图片预览正常？
A: 图片使用 `<img>` 标签，浏览器原生支持自定义协议

### Q: 视频播放会有同样的问题吗？
A: 可能。如果视频播放器使用 fetch，建议使用相同的预加载方案

### Q: 这个方案适用于所有 PDF 吗？
A: 适用于大多数 PDF，但超大文件（>100MB）可能需要特殊处理

### Q: 可以支持流式加载吗？
A: PDF.js 支持，但需要更复杂的实现。当前方案对大多数场景足够

## 参考资源

- [PDF.js API 文档](https://mozilla.github.io/pdf.js/api/)
- [react-pdf 文档](https://github.com/wojtekmaj/react-pdf)
- [Electron Protocol API](https://www.electronjs.org/docs/latest/api/protocol)
- [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)

---

**最后更新**: 2026-03-14 20:15
**状态**: ✅ 已验证有效
**适用版本**: Ready 0.1.0+
