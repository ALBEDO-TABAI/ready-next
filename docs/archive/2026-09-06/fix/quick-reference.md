---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../documentation-inventory.md)。

# 跨平台开发快速参考指南

> 快速查阅版本 - 用于日常开发

## 🚫 永远不要做的事

```typescript
// ❌ 硬编码路径
const LOG = '/tmp/ready.log'

// ❌ 硬编码分隔符
PATH: `${bin}:${venv}:${process.env.PATH}`

// ❌ 平台特定命令
execFileAsync('which', ['ffmpeg'])

// ❌ 假设路径格式
path.split('/').pop()
```

## ✅ 正确的做法

```typescript
// ✅ 使用系统临时目录
import { tmpdir } from 'os'
import { join } from 'path'
const LOG = join(tmpdir(), 'ready.log')

// ✅ 使用平台分隔符
import { delimiter } from 'path'
PATH: [bin, venv, process.env.PATH].join(delimiter)

// ✅ 平台检测
const cmd = process.platform === 'win32' ? 'where' : 'which'
const { stdout } = await execFileAsync(cmd, ['ffmpeg'])
const path = stdout.trim().split('\n')[0] // Windows 可能返回多行

// ✅ 跨平台路径处理
path.split(/[/\\]/).pop() // 同时匹配 / 和 \
```

## 📁 文件路径处理

### 路径标准化

```typescript
// Windows 路径转 URL
function normalizePathForUrl(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// 示例
normalizePathForUrl('C:\\Users\\test\\file.pdf')
// 结果: 'C:/Users/test/file.pdf'
```

### 文件名提取

```typescript
function getFilename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

// 示例
getFilename('/Users/test/file.pdf')      // 'file.pdf'
getFilename('C:\\Users\\test\\file.pdf') // 'file.pdf'
```

### 扩展名提取

```typescript
function getFileExtension(path: string): string {
  const filename = getFilename(path)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : ''
}

// 示例
getFileExtension('/Users/test/file.PDF') // 'pdf'
```

## 🌐 文件协议 URL

### 正确的 URL 格式

```typescript
// ✅ 正确 - 三个斜杠
'local-file:///Users/username/file.pdf'      // macOS
'local-file:///C:/Users/username/file.pdf'   // Windows

// ❌ 错误 - 两个斜杠
'local-file://Users/username/file.pdf'
'local-file://C:/Users/username/file.pdf'
```

### URL 构造

```typescript
function toLocalFileUrl(filePath: string): string {
  // 1. 标准化反斜杠
  const normalized = filePath.replace(/\\/g, '/')

  // 2. 编码特殊字符
  const encoded = encodeURI(normalized).replace(/#/g, '%23')

  // 3. 添加协议（三个斜杠）
  return `local-file:///${encoded}`
}
```

### 协议处理器

```typescript
protocol.handle('local-file', (request) => {
  const parsed = new URL(request.url)
  let filePath = parsed.host
    ? `/${parsed.host}${decodeURIComponent(parsed.pathname)}`
    : decodeURIComponent(parsed.pathname)

  // Windows: 修复路径
  if (process.platform === 'win32' && filePath.startsWith('/')) {
    filePath = filePath.slice(1)
    // 修复盘符大小写: c: -> C:
    if (filePath.length >= 2 && filePath[1] === ':') {
      filePath = filePath[0].toUpperCase() + filePath.slice(1)
    }
  }

  // 返回响应时添加 CORS 头
  return new Response(stream, {
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    },
  })
})
```

## 🔧 常用工具函数

### 平台检测

```typescript
// 检查是否为 Windows
const isWindows = process.platform === 'win32'

// 检查是否为 macOS
const isMacOS = process.platform === 'darwin'

// 检查是否为 Linux
const isLinux = process.platform === 'linux'
```

### 路径操作

```typescript
import { join, resolve, normalize, delimiter } from 'path'
import { tmpdir, homedir } from 'os'

// 拼接路径（自动使用正确的分隔符）
const fullPath = join('/Users', 'test', 'file.pdf')

// 解析相对路径
const absolute = resolve('./file.pdf')

// 标准化路径
const normalized = normalize('/Users/test/../file.pdf')

// 获取临时目录
const temp = tmpdir()

// 获取用户目录
const home = homedir()

// PATH 分隔符
const paths = ['/usr/bin', '/usr/local/bin'].join(delimiter)
```

## 🔒 安全检查

### 黑名单模式

```typescript
const sensitivePatterns = [
  /[/\\]\.ssh[/\\]/,           // SSH 密钥
  /[/\\]\.aws[/\\]/,           // AWS 凭证
  /[/\\]\.env$/,               // 环境变量
  /[/\\]credentials$/,         // 凭证文件
  /[/\\]\.npmrc$/,             // NPM 配置
  /[/\\]id_rsa/,               // RSA 私钥
]

function isPathAllowed(filePath: string): boolean {
  const normalized = normalize(resolve(filePath))

  // 阻止路径遍历
  if (normalized.includes('..')) return false

  // 检查黑名单
  const pathToCheck = normalized.toLowerCase()
  return !sensitivePatterns.some(pattern => pattern.test(pathToCheck))
}
```

## 🧪 测试代码

### 路径测试

```typescript
// 测试路径工具
console.log('Platform:', process.platform)
console.log('Delimiter:', delimiter)
console.log('Temp dir:', tmpdir())
console.log('Home dir:', homedir())

// 测试文件名提取
const testPaths = [
  '/Users/test/file.pdf',
  'C:\\Users\\test\\file.pdf',
  'D:/Projects/file.pdf',
]

testPaths.forEach(path => {
  console.log(`Path: ${path}`)
  console.log(`  Filename: ${getFilename(path)}`)
  console.log(`  Extension: ${getFileExtension(path)}`)
  console.log(`  URL: ${toLocalFileUrl(path)}`)
})
```

## 📋 开发检查清单

在提交代码前检查：

- [ ] 没有硬编码 `/tmp/` 路径
- [ ] 没有硬编码 `:` 或 `;` 分隔符
- [ ] 没有使用 `which` 命令（应该用平台检测）
- [ ] 路径分割使用 `/[/\\]/` 正则
- [ ] 文件 URL 使用三个斜杠
- [ ] 协议处理器设置了 CORS 头
- [ ] 安全检查使用黑名单而非白名单
- [ ] 在两个平台上测试过

## 🐛 常见错误排查

### PDF 无法预览

**症状**: PDF 文件打开后显示空白或加载失败

**检查**:
1. 控制台是否有 CORS 错误？
   - 修复：添加 CORS 头到协议处理器
2. URL 格式是否正确？
   - 应该是 `local-file:///` (三个斜杠)
3. Windows 路径是否正确转换？
   - 检查反斜杠是否转换为正斜杠
   - 检查盘符是否大写

### 日志文件无法写入

**症状**: 日志文件不存在或为空

**检查**:
1. 是否使用了 `tmpdir()`？
2. 路径是否正确拼接？
3. 权限是否正确？

### 技能运行失败

**症状**: Python 技能无法执行

**检查**:
1. PATH 分隔符是否正确？
2. `which`/`where` 命令是否正确？
3. 环境变量是否正确设置？

## 📚 参考资源

- [Node.js Path](https://nodejs.org/api/path.html)
- [Node.js OS](https://nodejs.org/api/os.html)
- [Electron Protocol](https://www.electronjs.org/docs/latest/api/protocol)
- [详细诊断文档](cross-platform-issues-diagnosis-and-fixes.md)
