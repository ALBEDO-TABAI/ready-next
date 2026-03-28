# PDF 预览问题诊断指南

> 创建时间: 2026-03-14 20:30
> 用于快速诊断 PDF 加载失败的问题

## 快速诊断步骤

### 1. 重启应用

```bash
# 停止当前运行的应用
# 然后重新启动
npm run dev
```

### 2. 打开开发者工具

- macOS: `Cmd + Option + I`
- Windows: `F12` 或 `Ctrl + Shift + I`

### 3. 打开 PDF 文件

在文件树中双击任意 PDF 文件

### 4. 查看控制台输出

应该看到类似这样的日志：

```
[PdfViewer] Loading PDF from: local-file:///Users/...
[Protocol] Handling request: local-file:///Users/...
[Protocol] Parsed path: { host: 'users', pathname: '/...', filePath: '/Users/...' }
[Protocol] Final path: /Users/.../file.pdf
[Protocol] File exists, serving: /Users/.../file.pdf
[PdfViewer] Fetch response: { status: 200, ... }
[PdfViewer] Loaded PDF data: 12345 bytes
```

## 常见错误及解决方案

### 错误 1: TypeError: Failed to fetch

**日志**:
```
[PdfViewer] PDF load error: TypeError: Failed to fetch
```

**可能原因**:
1. 协议处理器未正确注册
2. 协议名称不匹配
3. 应用未重启

**解决方法**:
```bash
# 完全停止应用
pkill -f "electron.*ready"

# 重新启动
npm run dev
```

### 错误 2: HTTP 403 Forbidden

**日志**:
```
[Protocol] Path not allowed: /Users/.../.ssh/...
[PdfViewer] PDF load error: HTTP 403: Forbidden
```

**原因**: 文件在黑名单中（敏感目录）

**解决方法**: 将 PDF 移到非敏感目录

### 错误 3: HTTP 404 Not Found

**日志**:
```
[Protocol] File not found: /Users/.../file.pdf
[PdfViewer] PDF load error: HTTP 404: Not Found
```

**原因**: 文件路径错误或文件不存在

**检查**:
```bash
# 检查文件是否存在
ls -la "/Users/.../file.pdf"
```

### 错误 4: 路径解析错误

**日志**:
```
[Protocol] Parsed path: { host: '', pathname: '...', filePath: '...' }
[Protocol] File not found: ...
```

**原因**: URL 格式不正确

**检查**: 确认 URL 格式为 `local-file:///` (三个斜杠)

### 错误 5: CORS 错误

**日志**:
```
Access to fetch at 'local-file://...' has been blocked by CORS policy
```

**原因**: CORS 头未正确设置

**检查**: 确认协议处理器返回了 CORS 头

## 详细诊断

### 检查协议注册

在主进程启动时应该看到：

```typescript
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,  // 关键！
      stream: true,
    }
  }
])
```

### 检查 URL 格式

正确的格式：
```
local-file:///Users/username/file.pdf  (macOS)
local-file:///C:/Users/username/file.pdf  (Windows)
```

错误的格式：
```
local-file://Users/username/file.pdf  (少一个斜杠)
file:///Users/username/file.pdf  (协议名错误)
```

### 检查文件权限

```bash
# macOS/Linux
ls -la /path/to/file.pdf

# 应该有读权限 (r)
-rw-r--r--  1 user  group  12345  date  file.pdf
```

### 检查协议处理器

在主进程日志中应该看到：

```
[Protocol] Handling request: local-file:///...
[Protocol] Parsed path: ...
[Protocol] Final path: ...
[Protocol] File exists, serving: ...
```

如果没有看到这些日志，说明协议处理器未被调用。

## 手动测试

### 测试 1: 直接 fetch

在浏览器控制台运行：

```javascript
fetch('local-file:///Users/user/Documents/test.pdf')
  .then(r => {
    console.log('Status:', r.status)
    console.log('Headers:', Object.fromEntries(r.headers.entries()))
    return r.arrayBuffer()
  })
  .then(data => console.log('Data size:', data.byteLength))
  .catch(err => console.error('Error:', err))
```

### 测试 2: 检查响应头

```javascript
fetch('local-file:///Users/user/Documents/test.pdf')
  .then(r => {
    console.log('CORS headers:')
    console.log('  Access-Control-Allow-Origin:', r.headers.get('Access-Control-Allow-Origin'))
    console.log('  Access-Control-Allow-Methods:', r.headers.get('Access-Control-Allow-Methods'))
    console.log('  Content-Type:', r.headers.get('Content-Type'))
  })
```

### 测试 3: 检查 PDF.js

```javascript
// 检查 PDF.js worker
console.log('PDF.js worker:', pdfjs.GlobalWorkerOptions.workerSrc)

// 应该输出类似：
// blob:http://localhost:5173/...pdf.worker.min.mjs
```

## 常见配置问题

### 问题 1: 协议未注册

**症状**: `Failed to fetch`

**检查**:
```typescript
// 确保在 app.whenReady() 之前调用
protocol.registerSchemesAsPrivileged([...])
```

### 问题 2: supportFetchAPI 未启用

**症状**: `Failed to fetch` 或 CORS 错误

**检查**:
```typescript
privileges: {
  supportFetchAPI: true,  // 必须为 true
}
```

### 问题 3: 协议处理器在错误的位置

**症状**: 协议处理器未被调用

**检查**:
```typescript
app.whenReady().then(() => {
  // 协议处理器应该在这里注册
  protocol.handle('local-file', ...)
})
```

### 问题 4: 路径重建错误

**症状**: 404 Not Found

**检查**:
```typescript
// 确保正确处理 host 和 pathname
let filePath = parsed.host
  ? `/${parsed.host}${decodedPathname}`
  : decodedPathname
```

## 完整的调试日志示例

### 成功的情况

```
[PdfViewer] Loading PDF from: local-file:///Users/test/doc.pdf
[Protocol] Handling request: local-file:///Users/test/doc.pdf
[Protocol] Parsed path: { host: 'users', pathname: '/test/doc.pdf', filePath: '/Users/test/doc.pdf' }
[Protocol] Final path: /Users/test/doc.pdf
[Protocol] File exists, serving: /Users/test/doc.pdf
[PdfViewer] Fetch response: { status: 200, statusText: 'OK', headers: {...} }
[PdfViewer] Loaded PDF data: 123456 bytes
```

### 失败的情况（文件不存在）

```
[PdfViewer] Loading PDF from: local-file:///Users/test/missing.pdf
[Protocol] Handling request: local-file:///Users/test/missing.pdf
[Protocol] Parsed path: { host: 'users', pathname: '/test/missing.pdf', filePath: '/Users/test/missing.pdf' }
[Protocol] Final path: /Users/test/missing.pdf
[Protocol] File not found: /Users/test/missing.pdf
[PdfViewer] Fetch response: { status: 404, statusText: 'Not Found', headers: {...} }
[PdfViewer] PDF load error: HTTP 404: Not Found
```

### 失败的情况（权限问题）

```
[PdfViewer] Loading PDF from: local-file:///Users/test/.ssh/key.pdf
[Protocol] Handling request: local-file:///Users/test/.ssh/key.pdf
[Protocol] Parsed path: { host: 'users', pathname: '/test/.ssh/key.pdf', filePath: '/Users/test/.ssh/key.pdf' }
[Protocol] Final path: /Users/test/.ssh/key.pdf
[Protocol] Path not allowed: /Users/test/.ssh/key.pdf
[PdfViewer] Fetch response: { status: 403, statusText: 'Forbidden', headers: {...} }
[PdfViewer] PDF load error: HTTP 403: Forbidden
```

## 下一步

1. **重启应用**: 确保所有修改生效
2. **打开开发者工具**: 查看详细日志
3. **尝试打开 PDF**: 观察日志输出
4. **记录错误信息**: 复制完整的错误日志
5. **对照上述情况**: 找到匹配的错误类型
6. **应用解决方案**: 根据错误类型修复

## 如果问题仍然存在

请提供以下信息：

1. **完整的控制台日志**（从打开 PDF 到显示错误）
2. **PDF 文件路径**（确认文件确实存在）
3. **操作系统**（macOS/Windows/Linux）
4. **应用版本**（`npm run dev` 或打包版本）

---

**最后更新**: 2026-03-14 20:30
