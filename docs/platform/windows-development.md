# Ready Windows 开发与源码交接

## Windows x64 本地构建

本分支使用 Electron 45.3.0、NSIS 和官方 Codex 0.160.1 x64。开发工具版本见 `.node-version` 和 `package.json#packageManager`。需要 Visual Studio C++ 工具链和 Python。运行文件符号链接回归时，Windows 账户需要对应权限，例如开启开发人员模式。

首次从此分支构建时，在仓库根目录的 PowerShell 中执行：

```powershell
npm ci
$lock = Get-Content assets/codex-runtime/source-lock.json -Raw | ConvertFrom-Json
$archive = Join-Path $env:TEMP $lock.releaseAsset.name
Invoke-WebRequest $lock.releaseAsset.url -OutFile $archive
node scripts/codex-runtime/prepare-pinned-runtime.cjs --archive $archive
New-Item -ItemType Directory -Force build/runtime-seeds | Out-Null
if (!(Test-Path build/runtime-seeds/ai-settings.seed.json)) {
  Set-Content build/runtime-seeds/ai-settings.seed.json '{}' -Encoding ascii
}
```

准备脚本校验发行档、解压后的程序、文件长度和 CLI 版本。以下命令构建本地测试包和运行主窗口冒烟检查。当前 Windows 目录只记录本平台的运行时目标，跨平台迁移旧会话仍需单独验证。

```powershell
npm run build
npm run licenses:generate
node scripts/check-ai-seed-release-safety.cjs
npx electron-builder --win nsis --x64 --publish never
node scripts/run-packaged-smoke.cjs --platform win32 --out test-results/windows-packaged-smoke.json
```

## 1. 完成标准

Windows 交接只有在以下条件都满足时才算完成：

1. 从一个经用户确认的共享镜像复制到 Windows 本地磁盘。
2. 依赖在 Windows 本机安装，native SQLite 在 Windows 本机重编。
3. `npm run verify:native`、`npm run typecheck` 与改动对应的专项 gate 通过，或每个失败都有明确证据。
4. 真实 Windows Electron 窗口完成与改动相称的 UI smoke。
5. 变更只回传到同一个共享镜像，并附起止提交、变更文件和验证结果。

只复制文件不叫完成。

## 2. 发布前记录基线

Mac 侧先记录：

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
node -p "require('./package.json').version"
node -p "require('./package.json').devDependencies.electron"
```

有未提交源文件时，按本次授权范围明确纳入或排除，并记录逐文件来源；不能仅用 HEAD 代表实际工作树。

共享镜像只是传输面，不在其上运行 install、dev、test 或 build。一次任务只使用一个镜像，不能从 A 拉取后向 B 回传。

本 checkout 是 `cod-ready`；不要套用写死到 `ready-cowork` 的旧同步工作流。使用本次明确的源码与目标镜像，先预览差异，再同步。

## 3. Windows intake

复制到 Windows 本地目录时排除：

- `node_modules`、`out`、`dist`、`exports`、`coverage`、测试输出与日志
- `.ready-data`、本机 seed、缓存和临时目录
- `.env*`、token、Cookie、OAuth code、provider key
- macOS `.app`、`.dmg` 和 native binary；受版本管理的构建图标等源码资产按目标配置保留
- Git 临时锁、worktree 内部状态

复制后先核对：

```powershell
git status --short --branch
git rev-parse HEAD
node -v
npm -v
```

起始提交必须与 Mac 交接记录一致；不是就停止，不要在错误快照上继续。

## 4. Windows setup

使用 `package.json#engines` 要求的 Node 版本，并在 Windows 本地执行：

```powershell
npm ci
npm run verify:native
npm run typecheck
```

不能通过修改源码、跳过 gate 或复制 Mac native 模块来掩盖安装/ABI 问题。

## 5. 验证

先跑改动对应的专项 gate。对广泛改动再跑：

```powershell
npm run test
npm run build
```

执行本文开头的包体冒烟检查，再分别验证真实 Agent、文件、网络和跨进程恢复。

真实 UI 至少按影响范围检查：

- 启动无白屏，窗口按钮与标题栏正常。
- Browser、Document、RSS、Calendar 可切换。
- BrowserView bounds 与 DOM 覆盖层不互相遮挡。
- 文档能在 scratch workspace 打开、编辑和保存。
- Agent 面板能显示运行、错误与确认状态。
- 设置页能打开；不得暴露真实密钥。
- 液态玻璃必须在真实聊天记录上检查，不能只看 `#/liquid-test`。
- 失败时查看 `%TEMP%\ready-directchat.log`、`ready-tools.log`、`ready-browser.log`。

## 6. Windows 不可破边界

- 路径使用 `app.getPath`、`process.resourcesPath`、`path.join`、`path.delimiter`，不硬编码 POSIX 分隔符。
- 右上角保留 Windows 原生最小化、最大化、关闭；Mica 只有普通背景 fallback 后才可启用。
- 不为 Windows 建永久旁路来绕过 Agent、工具、权限或持久化合同。
- 不把平台差异变成无批准的产品差异。
- 不提交密钥、Cookie、用户数据或带隐私的日志。

当前跨平台硬合同见 `docs/architecture/current-runtime-contracts.md` §1/§11；历史平台证据见 `docs/superpowers/audits/2026-05-24-stage-z-closeout/platform-parity.md` 与 `docs/superpowers/audits/2026-05-24-stage-z-closeout/platform-windows-smoke.md`。

## 7. 回传

回传前：

```powershell
git status --short
git diff --stat
npm run verify:native
npm run typecheck
```

停止 dev app 与 Electron 子进程，只把可重建源码回传到同一镜像。Mac 拉回后再次核对起止提交、dirty tree、native gate 和专项 gate。

最终报告必须包含：

- 起始与结束提交
- 改动文件
- 运行命令与结果
- 手工检查的 UI 表面
- Windows 特有差异及证据
- 回传使用的同一镜像
