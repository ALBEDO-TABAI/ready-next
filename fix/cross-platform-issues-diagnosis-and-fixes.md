# Ready 项目跨平台兼容性问题诊断与修复经验

> 文档创建时间: 2026-03-14
> 问题来源: Windows 移植经验 + PDF 预览问题

## 目录

1. [硬编码路径问题](#1-硬编码路径问题)
2. [PATH 环境变量分隔符问题](#2-path-环境变量分隔符问题)
3. [命令行工具平台差异](#3-命令行工具平台差异)
4. [文件路径与 URL 转换问题](#4-文件路径与-url-转换问题)
5. [文件协议 CORS 问题](#5-文件协议-cors-问题)
6. [安全检查过于严格](#6-安全检查过于严格)
7. [Mock 服务配置问题](#7-mock-服务配置问题)
8. [渲染进程路径显示问题](#8-渲染进程路径显示问题)

---

## 1. 硬编码路径问题

### 问题描述

代码中存在 8 处硬编码的 `/tmp/` 路径用于日志文件：

```typescript
const LOG = '/tmp/ready-directchat.log'
```

### 问题影响

- Windows 上 `/tmp/` 目录不存在
- 日志无法写入，导致调试困难
- 应用可能因为日志写入失败而出现异常

### 根本原因

Unix/Linux 系统有标准的 `/tmp/` 临时目录，但 Windows 使用 `%TEMP%` 环境变量指向的目录（通常是 `C:\Users\<用户名>\AppData\Local\Temp`）。

### 解决方案

**步骤 1**: 创建跨平台工具函数

```typescript
// src/main/utils/platform.ts
import { tmpdir } from 'os'
import { join } from 'path'

export function getLogPath(filename: string): string {
  return join(tmpdir(), filename)
}
```

**步骤 2**: 替换所有硬编码路径

```typescript
// 改前
const LOG = '/tmp/ready-directchat.log'

// 改后
import { getLogPath } from '../../utils/platform'
const LOG = getLogPath('ready-directchat.log')
```

### 修复文件清单

1. `src/main/modules/browser-engine/diagnostics-service.ts`
2. `src/main/modules/claude-bridge/direct-chat.ts`
3. `src/main/modules/claude-bridge/ipc-handler.ts` (2 处)
4. `src/main/modules/tools/browser-agent-runner.ts`
5. `src/main/modules/tools/browser-tools.ts`
6. `src/main/modules/tools/memory-tools.ts`
7. `src/main/modules/tools/system-tools.ts`

### 验证方法

```bash
# macOS
ls -la /tmp/ready-*.log

# Windows (PowerShell)
dir $env:TEMP\ready-*.log
```

---

## 2. PATH 环境变量分隔符问题

### 问题描述

代码中使用硬编码的 `:` 作为 PATH 分隔符：

```typescript
PATH: `${this.runtimeBin}:${venvBinDir}:${process.env.PATH || ''}`
```

### 问题影响

- Windows 使用 `;` 作为 PATH 分隔符
- 环境变量配置错误导致 Python 技能无法找到正确的可执行文件
- 技能运行时失败

### 根本原因

不同操作系统使用不同的 PATH 分隔符：
- Unix/Linux/macOS: `:`
- Windows: `;`

### 解决方案

使用 Node.js 内置的 `path.delimiter`：

```typescript
// 改前
import { join } from 'path'
PATH: `${this.runtimeBin}:${venvBinDir}:${process.env.PATH || ''}`

// 改后
import { join, delimiter } from 'path'
PATH: [this.runtimeBin, venvBinDir, process.env.PATH || ''].join(delimiter)
```

### 修复文件

- `src/main/modules/skills-runtime/runtime-manager.ts:1286`

### 验证方法

```typescript
// 测试代码
console.log('PATH delimiter:', require('path').delimiter)
// macOS/Linux: ':'
// Windows: ';'
```

---

## 3. 命令行工具平台差异

### 问题描述

代码中使用 `which` 命令查找可执行文件：

```typescript
const { stdout } = await execFileAsync('which', ['ffmpeg'])
```

### 问题影响

- Windows 上 `which` 命令不存在
- 导致 ffmpeg 等工具无法找到
- 技能运行时失败

### 根本原因

- Unix/Linux/macOS: 使用 `which` 命令
- Windows: 使用 `where` 命令

### 解决方案

**步骤 1**: 创建平台检测函数

```typescript
// src/main/utils/platform.ts
export function getWhichCommand(): string {
  return process.platform === 'win32' ? 'where' : 'which'
}
```

**步骤 2**: 使用平台特定命令

```typescript
// 改前
const { stdout } = await execFileAsync('which', ['ffmpeg'])
const path = stdout.trim()

// 改后
import { getWhichCommand } from '../../utils/platform'
const { stdout } = await execFileAsync(getWhichCommand(), ['ffmpeg'])
// Windows 'where' 可能返回多行，取第一行
const path = stdout.trim().split('\n')[0]
```

### 修复文件

1. `src/main/modules/skills-runtime/runtime-manager.ts:1271`
2. `src/main/modules/claude-bridge/direct-chat.ts:4887`

### 注意事项

Windows 的 `where` 命令可能返回多个匹配路径（每行一个），需要取第一行。

---

## 4. 文件路径与 URL 转换问题

### 问题描述

代码中使用 `.split('/')` 处理文件路径：

```typescript
function toLocalFileUrl(filePath: string): string {
  const encoded = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `local-file://${encoded}`
}
```

### 问题影响

- Windows 路径使用反斜杠 `\`（如 `C:\Users\...`）
- 路径分割失败，导致 URL 构造错误
- 文件预览功能完全不可用

### 根本原因

不同操作系统使用不同的路径分隔符：
- Unix/Linux/macOS: `/`
- Windows: `\`（但也支持 `/`）

### 解决方案

**步骤 1**: 创建路径标准化函数

```typescript
// src/shared/path-utils.ts
export function normalizePathForUrl(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// src/renderer/utils/path.ts
export function getFilename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function getFileExtension(path: string): string {
  const filename = getFilename(path)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : ''
}
```

**步骤 2**: 修复主进程 URL 构造

```typescript
// src/main/modules/document-engine/ipc-handler.ts
function toLocalFileUrl(filePath: string): string {
  // 标准化 Windows 反斜杠为正斜杠
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `local-file:///${encoded}` // 三斜杠格式
}
```

**步骤 3**: 修复渲染进程 URL 构造

```typescript
// src/renderer/utils/dragDrop.ts
export function toLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return `local-file:///${encodeURI(normalized).replace(/#/g, '%23')}`
}
```

**步骤 4**: 修复协议处理器

```typescript
// src/main/index.ts
protocol.handle('local-file', (request) => {
  const parsed = new URL(request.url)
  const decodedPathname = decodeURIComponent(parsed.pathname)
  let filePath = parsed.host
    ? `/${parsed.host}${decodedPathname}`
    : decodedPathname

  // Windows: 移除前导斜杠并修复盘符大小写
  if (process.platform === 'win32' && filePath.startsWith('/')) {
    filePath = filePath.slice(1)
    // 修复小写盘符: c:/path -> C:/path
    if (filePath.length >= 2 && filePath[1] === ':') {
      filePath = filePath[0].toUpperCase() + filePath.slice(1)
    }
  }
  // ... 后续处理
})
```

### 修复文件清单

**主进程**:
- `src/main/modules/document-engine/ipc-handler.ts`
- `src/main/index.ts` (协议处理器)

**渲染进程**:
- `src/renderer/utils/dragDrop.ts`
- `src/renderer/components/document/FilePreview.tsx`
- `src/renderer/components/document/ImageGallery.tsx`
- `src/renderer/stores/useWorkspace.ts`
- `src/renderer/stores/useDocTabs.ts`
- `src/renderer/pages/modes/DocumentMode.tsx`

### URL 格式说明

正确的 `local-file://` URL 格式：

```
macOS:   local-file:///Users/username/file.pdf
Windows: local-file:///C:/Users/username/file.pdf
         (注意三个斜杠，盘符大写)
```

---

## 5. 文件协议 CORS 问题

### 问题描述

PDF 预览功能无法正常工作，PDF.js 无法加载文件。

### 问题影响

- PDF 文件无法预览
- 浏览器控制台显示 CORS 错误
- 影响用户体验

### 根本原因

PDF.js 使用 `fetch` API 加载 PDF 文件，但自定义协议处理器没有设置 CORS 头，导致浏览器阻止跨域请求。

### 诊断方法

1. 打开开发者工具控制台
2. 尝试打开 PDF 文件
3. 查看网络请求和控制台错误
4. 确认是否有 CORS 相关错误

### 解决方案

在协议处理器的响应中添加 CORS 头：

```typescript
// src/main/index.ts
protocol.handle('local-file', (request) => {
  // ... 路径处理代码 ...

  // 部分内容响应（Range 请求）
  if (rangeHeader) {
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
  }

  // 完整文件响应
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

### 修复文件

- `src/main/index.ts` (协议处理器)

### 验证方法

1. 重启应用
2. 打开一个 PDF 文件
3. 确认 PDF 正常显示
4. 检查控制台无 CORS 错误

### 为什么需要 CORS 头

- `local-file://` 是自定义协议，被视为跨域资源
- PDF.js 使用 `fetch` API，需要 CORS 头才能访问
- `Access-Control-Allow-Origin: *` 允许所有来源访问
- `Accept-Ranges: bytes` 支持 PDF 的分段加载

---

## 6. 安全检查过于严格

### 问题描述

文件访问安全检查限制路径必须在用户 home 目录内：

```typescript
if (!normalizedCmp.startsWith(homeCmp)) {
  return false
}
```

### 问题影响

- Windows 用户无法访问其他盘符（D:, E: 等）的文件
- 限制了应用的实用性
- 用户体验差

### 根本原因

原始设计假设所有用户文件都在 home 目录内，但这在 Windows 上不现实：
- 用户可能在多个盘符存储文件
- 外接硬盘、网络驱动器等

### 解决方案

改用黑名单机制，只阻止敏感文件和目录：

```typescript
// src/main/index.ts
function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath)
  const normalized = normalize(resolved)

  // 阻止路径遍历
  if (normalized.includes('..')) {
    return false
  }

  // 黑名单：敏感模式（大小写不敏感）
  const sensitivePatterns = [
    /[/\\]\.ssh[/\\]/,
    /[/\\]\.aws[/\\]/,
    /[/\\]\.gnupg[/\\]/,
    /[/\\]\.env$/,
    /[/\\]credentials$/,
    /[/\\]credentials\.json$/,
    /[/\\]\.npmrc$/,
    /[/\\]\.pypirc$/,
    /[/\\]\.gitconfig$/,
    /[/\\]id_rsa/,
    /[/\\]id_ed25519/,
  ]

  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
  const pathToCheck = caseInsensitive ? normalized.toLowerCase() : normalized

  for (const pattern of sensitivePatterns) {
    if (pattern.test(pathToCheck)) {
      return false
    }
  }

  return true
}
```

### 修复文件

- `src/main/index.ts`

### 安全考虑

黑名单包含：
- SSH 密钥目录 (`.ssh`)
- AWS 凭证 (`.aws`)
- 环境变量文件 (`.env`)
- 各种凭证文件 (`credentials`, `.npmrc`, `.pypirc`)
- Git 配置 (`.gitconfig`)
- 私钥文件 (`id_rsa`, `id_ed25519`)

### 验证方法

```typescript
// 测试代码
console.log(isPathAllowed('/Users/test/.ssh/id_rsa')) // false
console.log(isPathAllowed('/Users/test/Documents/file.pdf')) // true
console.log(isPathAllowed('D:/Projects/file.pdf')) // true (Windows)
```

---

## 7. Mock 服务配置问题

### 问题描述

Production 环境默认启用 Mock 服务：

```typescript
const ENABLE_MOCK_SERVICES = is.dev
  ? process.env.ENABLE_MOCK_SERVICES === 'true'
  : process.env.ENABLE_MOCK_SERVICES !== 'false' // 默认 true
```

### 问题影响

- 打包后的应用默认使用模拟数据
- 浏览器和日历功能不可用
- 用户困惑，以为应用有 bug

### 根本原因

配置逻辑错误：
- Development: opt-in (需要显式启用)
- Production: opt-out (需要显式禁用)

这导致 production 默认使用 mock 数据。

### 解决方案

统一为 opt-in 模式：

```typescript
// src/main/index.ts
// 改前
const ENABLE_MOCK_SERVICES = is.dev
  ? process.env.ENABLE_MOCK_SERVICES === 'true'
  : process.env.ENABLE_MOCK_SERVICES !== 'false'

const RSS_USE_MOCK = process.env.ENABLE_MOCK_RSS === 'true'

// 改后
const ENABLE_MOCK_SERVICES = process.env.ENABLE_MOCK_SERVICES === 'true'
const RSS_USE_MOCK = ENABLE_MOCK_SERVICES
```

### 修复文件

- `src/main/index.ts`

### 使用方法

如果需要启用 Mock 服务（用于开发或测试）：

```bash
# 设置环境变量
export ENABLE_MOCK_SERVICES=true

# 或在 .env 文件中
ENABLE_MOCK_SERVICES=true
```

### 验证方法

1. 打包应用：`npm run build`
2. 运行打包后的应用
3. 确认浏览器和日历功能正常工作
4. 不应该看到 "演示模式" 提示

---

## 8. 渲染进程路径显示问题

### 问题描述

渲染进程使用 `.split('/')` 提取文件名：

```typescript
const title = path.split('/').pop() || '未知文件'
```

### 问题影响

- Windows 路径显示可能不正确
- 文件名提取失败
- UI 显示异常

### 根本原因

Windows 路径使用反斜杠 `\`，`.split('/')` 无法正确分割。

### 解决方案

使用跨平台路径工具：

```typescript
// src/renderer/utils/path.ts
export function getFilename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function getFileExtension(path: string): string {
  const filename = getFilename(path)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : ''
}
```

使用示例：

```typescript
// 改前
const title = path.split('/').pop() || '未知文件'

// 改后
import { getFilename } from '../../utils/path'
const title = getFilename(path)
```

### 修复文件清单

1. `src/renderer/stores/useWorkspace.ts`
2. `src/renderer/pages/modes/DocumentMode.tsx`
3. `src/renderer/stores/useDocTabs.ts`
4. `src/renderer/components/document/FilePreview.tsx`

### 验证方法

```typescript
// 测试代码
import { getFilename, getFileExtension } from './utils/path'

console.log(getFilename('/Users/test/file.pdf'))      // 'file.pdf'
console.log(getFilename('C:\\Users\\test\\file.pdf')) // 'file.pdf'
console.log(getFileExtension('/Users/test/file.pdf')) // 'pdf'
```

---

## 总结

### 核心原则

1. **永远不要硬编码路径分隔符** - 使用 `path.join()`, `path.delimiter`
2. **永远不要假设路径格式** - 使用正则表达式 `/[/\\]/` 匹配两种分隔符
3. **使用 Node.js 内置 API** - `os.tmpdir()`, `path.delimiter`, `process.platform`
4. **测试跨平台行为** - 在 macOS 和 Windows 上都要测试

### 检查清单

开发新功能时，检查以下内容：

- [ ] 是否使用了硬编码路径？
- [ ] 是否使用了硬编码路径分隔符？
- [ ] 是否使用了平台特定命令？
- [ ] 是否正确处理了 Windows 盘符？
- [ ] 是否设置了必要的 CORS 头？
- [ ] 是否考虑了大小写敏感性？
- [ ] 是否在两个平台上测试过？

### 工具函数库

创建以下工具模块以避免重复问题：

1. **`src/main/utils/platform.ts`** - 主进程平台工具
   - `getLogPath()` - 日志路径
   - `getTitleBarStyle()` - 标题栏样式
   - `getWhichCommand()` - 命令查找工具

2. **`src/shared/path-utils.ts`** - 共享路径工具
   - `normalizePathForUrl()` - 路径标准化
   - `pathBasename()` - 文件名提取
   - `pathExtension()` - 扩展名提取

3. **`src/renderer/utils/path.ts`** - 渲染进程路径工具
   - `getFilename()` - 文件名提取
   - `getFileExtension()` - 扩展名提取

### 参考资源

- [Node.js Path 文档](https://nodejs.org/api/path.html)
- [Node.js OS 文档](https://nodejs.org/api/os.html)
- [Electron Protocol 文档](https://www.electronjs.org/docs/latest/api/protocol)
- [CORS 规范](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)

---

## 附录：快速修复脚本

如果遇到类似问题，可以使用以下检查脚本：

```bash
#!/bin/bash
# check-cross-platform.sh

echo "检查硬编码路径..."
grep -r "'/tmp/" src/ --include="*.ts" --include="*.tsx"

echo "\n检查硬编码分隔符..."
grep -r '":${' src/ --include="*.ts" --include="*.tsx"

echo "\n检查 which 命令..."
grep -r "'which'" src/ --include="*.ts" --include="*.tsx"

echo "\n检查路径分割..."
grep -r "\.split('/')" src/ --include="*.ts" --include="*.tsx"
```

运行：

```bash
chmod +x check-cross-platform.sh
./check-cross-platform.sh
```
