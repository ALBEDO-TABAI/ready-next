# PDF 预览问题修复总结

## 问题描述

PDF 文件无法在应用中预览，打开 PDF 文件后显示空白或加载失败。

## 根本原因

PDF.js 使用 `fetch` API 加载 PDF 文件，但自定义的 `local-file://` 协议处理器没有设置 CORS（跨域资源共享）响应头，导致浏览器阻止了跨域请求。

## 技术细节

### 为什么需要 CORS 头？

1. **自定义协议被视为跨域资源**
   - `local-file://` 是自定义协议，不同于标准的 `http://` 或 `https://`
   - 浏览器将其视为不同的源（origin）

2. **PDF.js 使用 fetch API**
   - PDF.js 库使用现代的 `fetch` API 加载文件
   - `fetch` 默认执行 CORS 检查
   - 没有正确的 CORS 头，请求会被阻止

3. **Electron 的安全策略**
   - Electron 遵循浏览器的同源策略
   - 自定义协议需要显式允许跨域访问

## 解决方案

在 `local-file://` 协议处理器的响应中添加 CORS 头：

```typescript
// src/main/index.ts
protocol.handle('local-file', (request) => {
  // ... 路径处理和文件读取代码 ...

  // 对于部分内容响应（Range 请求）
  return new Response(readable, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes',
      // 添加 CORS 头
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    },
  })

  // 对于完整文件响应
  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
      // 添加 CORS 头
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    },
  })
})
```

## CORS 头说明

### Access-Control-Allow-Origin: *

- 允许所有来源访问资源
- 对于本地文件协议，这是安全的
- 因为文件已经在用户的本地系统上

### Access-Control-Allow-Methods: GET, HEAD, OPTIONS

- 允许的 HTTP 方法
- `GET`: 获取文件内容
- `HEAD`: 获取文件元数据
- `OPTIONS`: CORS 预检请求

### Access-Control-Allow-Headers: Range

- 允许的请求头
- `Range`: 支持分段加载（对 PDF 和视频很重要）
- PDF.js 使用 Range 请求来按需加载 PDF 页面

## 修复文件

- `src/main/index.ts` (两处：部分响应和完整响应)

## 验证步骤

1. 重启应用
2. 打开一个 PDF 文件
3. 确认 PDF 正常显示
4. 打开开发者工具控制台
5. 确认没有 CORS 相关错误

## 相关问题

这个修复同时解决了：

1. **PDF 预览** - PDF.js 可以正常加载文件
2. **视频播放** - 视频播放器也使用 fetch 和 Range 请求
3. **图片加载** - 某些图片库也可能使用 fetch

## 为什么之前没有发现？

1. **图片预览正常**
   - 图片使用 `<img>` 标签，不受 CORS 限制
   - `<img>` 标签可以加载任何协议的资源

2. **视频可能也有问题**
   - 如果视频播放器使用 `<video>` 标签，可能正常
   - 如果使用 fetch API，会有同样的问题

3. **PDF 特殊性**
   - PDF.js 必须使用 fetch API
   - 因为需要按需加载和解析 PDF 内容
   - 不能简单地使用 `<embed>` 或 `<iframe>`

## 经验教训

### 1. 自定义协议需要完整的 HTTP 语义

自定义协议处理器应该像真正的 HTTP 服务器一样：
- 设置正确的 Content-Type
- 支持 Range 请求
- 设置 CORS 头
- 处理错误状态码

### 2. 测试不同类型的文件

不同类型的文件可能使用不同的加载机制：
- 图片：`<img>` 标签
- 视频：`<video>` 标签或 fetch
- PDF：必须使用 fetch
- 音频：`<audio>` 标签或 fetch

### 3. 检查浏览器控制台

CORS 错误会在控制台中明确显示：
```
Access to fetch at 'local-file:///.../file.pdf' from origin 'file://'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

### 4. 协议注册配置

确保协议注册时启用了必要的特权：

```typescript
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,        // 标准协议
      secure: true,          // 安全协议
      supportFetchAPI: true, // 支持 fetch API ⭐
      stream: true,          // 支持流式传输
    }
  }
])
```

`supportFetchAPI: true` 是关键，但仅有这个还不够，还需要 CORS 头。

## 安全考虑

### 为什么 Access-Control-Allow-Origin: * 是安全的？

1. **文件已在本地**
   - 用户已经有权访问这些文件
   - 不是从远程服务器加载

2. **协议限制**
   - `local-file://` 只能访问本地文件
   - 已经有路径安全检查（黑名单）

3. **应用内部使用**
   - 只有应用内部的渲染进程可以访问
   - 不会暴露给外部网站

### 如果需要更严格的安全性

可以限制 Origin：

```typescript
'Access-Control-Allow-Origin': 'file://'
```

但这可能在某些情况下不工作，因为 Electron 的渲染进程可能使用不同的 origin。

## 参考资源

- [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Electron Protocol API](https://www.electronjs.org/docs/latest/api/protocol)
- [PDF.js Documentation](https://mozilla.github.io/pdf.js/)
- [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)

## 相关文档

- [跨平台问题诊断与修复](./cross-platform-issues-diagnosis-and-fixes.md)
- [快速参考指南](./quick-reference.md)
