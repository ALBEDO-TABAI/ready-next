# Clean Packer

`Packer/pack-clean-release.mjs` 用于生成“干净发行包”，输出仍然写入根目录的 `exports/`。

它和直接执行 `npm run build:dist` 的区别是：

- 不读取当前用户数据库，也不会把本机 AI API 配置打进安装包
- 会覆盖 `ai-settings.seed.json` 为一个空 seed
- 会复制一份净化后的 `src/python/` sidecar 资源，自动移除 `__pycache__`、`.pyc`、`.pyo`、`.pytest_cache`、`.mypy_cache`、`.DS_Store`
- 会复制一份净化后的 `assets/embedded-skills/`，避免把 skill 脚本缓存一并带进发行包
- 会清理 `exports/` 下旧的构建结果，然后再重新产出
- 会在打包结束后检查发行包内是否仍然混入 `ready.db`、`agent-memory`、`channel-attachments`、`puppeteer-cache` 等运行时数据
- 会把校验摘要写到 `exports/clean-package-manifest.json`

## 用法

```bash
npm run pack:clean
```

可选参数：

```bash
node ./Packer/pack-clean-release.mjs --dir-only
node ./Packer/pack-clean-release.mjs --skip-clean-exports
node ./Packer/pack-clean-release.mjs --keep-staging
```

参数说明：

- `--dir-only`: 只输出 `.app` 目录，不生成 DMG
- `--skip-clean-exports`: 不删除 `exports/` 下旧的 Ready 构建产物
- `--keep-staging`: 保留 `Packer/.staging/` 中间文件，方便排查

## 明确不打包的运行时状态

这个打包器会把以下内容视为“不应该进入发行包”的运行时数据：

- API 配置 seed 中的 `ai_model_config` / `ai_saved_configs`
- 浏览器历史、书签、下载记录数据库
- 飞书 / Telegram 远程 IM 运行时配置与附件缓存
- Agent 记忆、反思、sidecar runtime、skill runtime
- Puppeteer / RSS runtime cache
- Python 解释器缓存与 `.DS_Store`

如果校验仍然发现这些内容进入了发行包，脚本会直接失败。
