# Packer

这个目录下有两个打包器：

1. **Web 专属包打包器（`server.mjs`）** —— 浏览器里填 AI 接口配置和打包名，一键生成“已内置该配置”的专属 DMG。
2. **Clean Packer（`pack-clean-release.mjs`）** —— 命令行“干净发行包”打包器，写入空 seed 并断言安装包里不含任何 API Key / 用户运行时数据。

两者用途相反：Web 打包器**内置**指定 AI 配置，Clean Packer**剔除**所有 AI 配置。

---

## 一、Web 专属包打包器

在网页里配置内置的 AI 模型接口（Base URL / API Key / 模型）与最终打包名，然后一键打包，
产出一个首次启动即预置该 AI 配置的 macOS DMG。

```bash
npm --prefix Packer start
# 打开日志里打印的地址，默认 http://127.0.0.1:4291/
```

无需 `npm install`，纯 Node 内置模块实现。

### 配置项

- **Base URL** —— 默认预填 `https://cn-novacode.i0yu.cn/v1`（NovaCode，OpenAI 兼容网关）。只填域名或 IP 时会自动补 `/v1`；已填自定义路径时保持原样。
- **API Key** —— 可选。留空则生成的包首次启动时需在“设置 › AI”里补填 Key。
- **模型** —— 默认预填 `gpt-5.6-terra`。
- **预设名称** —— 默认 `NovaCode`，显示在应用内模型切换器里。
- **打包名后缀** —— 可选。填 `张三` 则输出 `Ready-张三.dmg`；留空则用默认版本号命名 `Ready-<version>-arm64.dmg`。
- **生成精简包** —— 默认开启。不内置 `skill-runtime`，体积接近 `ready-pack` 的最小包；依赖 Python/ffmpeg 的技能首次使用时在应用内安装运行时。
- **skill-runtime 目录** —— 只有主动取消“生成精简包”时才需要。可填写 `READY_RELEASE_SKILL_RUNTIME_ROOT` 或 `~/ready-release-runtime-src`
  这类含 `runtime-manifest.json` 的目录，生成包含技能运行时的完整包。

三项 AI 配置全部留空时会写入空 seed，产出一个不内置任何 AI 配置的干净包。

### 它做了什么

内置的 AI 配置会写进应用资源里的 `ai-settings.seed.json`（`openai-compatible` 供应商），
应用首次在空数据库上启动时由 `applyBundledAISettingsSeed()` 导入，并迁移成一个默认激活的自定义预设。

默认精简包复用 `ready-pack` 的底层路径，只有主动选择完整包时才走下面的 Clean Packer：

1. 把本次配置写成一个临时 seed 文件（`Packer/.staging/packer-seed-<job>.json`）。
2. 精简包会临时写入 `build/runtime-seeds/ai-settings.seed.json`，执行 `npm run build:dist`，
   打完后恢复开发机原来的 seed 文件。这和 `ready-pack` 的核心路径一致：普通 `electron-builder.yml`、
   普通 `build:dist`、不内置 `skill-runtime`。
3. 完整包才以 `READY_PACKER_SEED_CONFIG=<该文件>`、`READY_PACKER_ALLOW_BAKED_KEY=1`、
   `READY_RELEASE_SKILL_RUNTIME_ROOT=<skill-runtime>` 调用 `pack-clean-release.mjs`。
   Clean Packer 负责净化 sidecar/embedded-skills、暂存并内置 `skill-runtime`、electron-builder、
   用 `hdiutil` 重建 DMG、挂载校验 `Ready.app` 签名与 Electron Framework。
4. 从主项目 `electron-builder.yml` 实时读取输出目录、产品名、DMG 架构和文件名；复制到临时输出后，逐项核对配置、运行时形态、Electron Framework、签名、DMG 完整性和只读挂载内容，全部通过才原子替换 `Packer/output/` 的正式文件。

精简包会短暂写入 `build/runtime-seeds/ai-settings.seed.json`，临时文件和备份均只允许当前用户读取，打包结束后恢复原文件；若进程意外中断，下次启动 Packer 会先恢复最早的开发机 seed 并清除遗留副本。
打包中间目录权限为 `0700`；无论成功还是失败，任务结束前都会删除 `exports/` 中可能含 API Key 的 app、DMG、ZIP、blockmap 和元数据。正式 `Packer/output/*.dmg` 权限为 `0600`。
普通 `npm run build:dist` 默认拒绝打包非空 seed，只有 Web Packer 受控任务会临时放行，避免把开发机配置误带进安装包。
完整包才走 Clean Packer 的暂存 seed。日志里的 API Key 会脱敏显示；
`READY_PACKER_ALLOW_BAKED_KEY=1` 只在完整包路径里放行「有意内置的 Key」，
默认（不带此环境变量）Clean Packer 仍会断言发行包内不含任何 Key。

### 输出目录

```text
Packer/output/
```

最终 DMG 旁保留同名 `.receipt.json`。源码身份在编译前冻结，编译完成和打包完成均检查源码/编译输出未变；Packer 复制时只转交原回执。Clean Packer 在重建最终 DMG 并写出本轮净化清单后刷新包摘要。安装验收同时核对 DMG、包内构建记录和当前审查源码；旧回执、旧净化清单或打包后重新计算的源码摘要不能替代这条交接。

`buildIdentity.source.dirty` 如实标记发布输入中尚未提交的修改、新增和删除（包括已暂存项）；生成目录不计入。Git HEAD 只是基点，实际工作树以同一 source digest 为准。

### node_modules 符号链接的物化（关键）

本仓库的 `node_modules` 是指向 `ready-cowork/node_modules` 的**符号链接**（共享安装省磁盘）。
electron-builder 的依赖收集器能顺着符号链接解析出完整依赖树，但它的**文件打包器不会进入符号链接的
`node_modules` 根目录**，结果只打进约 93/1188 个生产依赖，丢掉 `bindings`/`ws`/`undici` 等传递依赖 ——
包既偏小（~150M）又缺依赖（`better-sqlite3` 加载不了）。这正是「出包只有 150M」的根因。

因此打包前若检测到 `node_modules` 是符号链接，会先用 APFS `cp -Rc`（clonefile，约 15s、写时复制、几乎不占额外磁盘）
把它**临时物化成真实目录**，构建结束后再还原符号链接（原符号链接暂存在 `Packer/.staging/node_modules.symlink`，
进程中途被杀也会在下次启动自愈）。物化后精简包能完整打进 1188 个依赖，体积回到正常的 230-300 MiB。

### 说明与边界

- **默认精简包不内置 skill-runtime**：AI 对话 / 浏览 / 文稿主链路可用，Python 类技能需应用内按需安装，体积应接近 `ready-pack` 的 230-300 MiB 区间。
- **完整包体积由 skill-runtime 决定**：当前发布 runtime 含 Python + ffmpeg + torch/funasr 等 ML 依赖（约 1.4G 未压缩），
  完整 DMG 因此在 600M+ 量级。只有明确需要离线内置技能运行时时才取消“生成精简包”。
- 出包体积到 600M+ 通常意味着**内置了 skill-runtime**；页面顶部的运行时状态就是用来提前暴露这一点的。
- 仅支持 macOS arm64 DMG（与本项目当前打包目标一致）。一次只允许一个打包任务（写共享 `exports/`）。

---

## 二、Clean Packer

`Packer/pack-clean-release.mjs` 用于生成“干净发行包”，输出仍然写入根目录的 `exports/`。

它和直接执行 `npm run build:dist` 的区别是：

- 不读取当前用户数据库，也不会把本机 AI API 配置打进安装包
- 会覆盖 `ai-settings.seed.json` 为一个空 seed
- 会复制一份净化后的 `src/python/` sidecar 资源，自动移除 `__pycache__`、`.pyc`、`.pyo`、`.pytest_cache`、`.mypy_cache`、`.DS_Store`
- 会复制一份净化后的 `assets/embedded-skills/`，避免把 skill 脚本缓存一并带进发行包
- 会要求提供一份预构建的共享 `skill-runtime`，让内置技能安装后即可使用，不依赖用户机器现场安装 Python、ffmpeg 或 pip 依赖
- 会清理 `exports/` 下旧的构建结果，然后再重新产出
- 会在打包结束后检查发行包内是否仍然混入 `ready.db`、`agent-memory`、`channel-attachments`、`puppeteer-cache` 等运行时数据
- 会挂载最终 DMG，确认镜像里的 `Ready.app` 仍包含 Electron Framework 主文件且签名有效
- 会把校验摘要写到 `exports/clean-package-manifest.json`

### 用法

```bash
READY_RELEASE_SKILL_RUNTIME_ROOT=/path/to/release/skill-runtime npm run pack:clean
```

`READY_RELEASE_SKILL_RUNTIME_ROOT` 指向的目录必须包含：

- `runtime-manifest.json`
- `python/bin/python3`（Windows 为 `python/Scripts/python.exe`）
- `bin/ffmpeg` 与 `bin/ffprobe`
- 内置视频 / OCR / RSS 技能需要的 Python 包与模型缓存

`runtime-manifest.json` 的 `embeddedSkillIds` 必须覆盖 `Packer/pack-clean-release.mjs` 里的 `REQUIRED_RUNTIME_SKILLS`。即便 `context-compact` 这类 reference skill 没有额外 Python 依赖，也要写入 manifest；否则 clean packer 会在复制 packaged runtime 阶段失败。

macOS DMG 会在 electron-builder 生成后由 clean packer 用 `hdiutil` 重建，并立刻挂载最终镜像做 app 级校验。不要只用 `hdiutil verify` 的 checksum 当通过；还必须确认镜像内 `Ready.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework` 存在并且 app 签名有效。

仅开发调试、明确允许运行时联网补依赖时，才使用：

```bash
npm run pack:clean -- --allow-network-runtime
```

可选参数：

```bash
node ./Packer/pack-clean-release.mjs --dir-only
node ./Packer/pack-clean-release.mjs --skip-clean-exports
node ./Packer/pack-clean-release.mjs --keep-staging
node ./Packer/pack-clean-release.mjs --allow-network-runtime
```

参数说明：

- `--dir-only`: 只输出 `.app` 目录，不生成 DMG
- `--skip-clean-exports`: 不删除 `exports/` 下旧的 Ready 构建产物
- `--keep-staging`: 保留 `Packer/.staging/` 中间文件，方便排查
- `--allow-network-runtime`: 开发调试用，允许不随包携带技能运行时；正式发行不使用

### 明确不打包的运行时状态

这个打包器会把以下内容视为“不应该进入发行包”的运行时数据：

- API 配置 seed 中的 `ai_model_config` / `ai_saved_configs`
- 浏览器历史、书签、下载记录数据库
- 飞书 / Telegram 远程 IM 运行时配置与附件缓存
- Agent 记忆、反思、sidecar runtime、历史用户态 skill runtime
- `skill-runtime/cache/pip` 与旧 Whisper 缓存；发行包只带可复用的共享运行时、必要模型和必要二进制
- Puppeteer / RSS runtime cache
- Python 解释器缓存与 `.DS_Store`

如果校验仍然发现这些内容进入了发行包，脚本会直接失败。
