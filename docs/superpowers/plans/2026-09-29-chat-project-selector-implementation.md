# 聊天项目目录选择器

状态：已实现并完成源码、开发窗口与安装版验收。范围：本地聊天的默认项目目录，不创建 Git 项目，不改变内部 Codex thread cwd。

## 事实与取舍

- 参考用户四张截图及本机 ChatGPT Matrix Runtime.app 的 `composer-project-picker-content-a2db13761e8f.js`：搜索名称/路径、当前项勾选、清除独立于项目创建；执行位置另有菜单。
- Ready 上沿入口是 ChatPanel → ChatPanelBody → DraggableModeTabs，玻璃样式在 liquid-composer.css。
- Ready 的内部 cwd 参与历史接续、回收及唯一性约束，不能改成用户目录。复用显式 local_directory → resource authority → outputContract → artifact export 的现行链。
- 目录选择是本地 scope 元数据；新聊天不继承，远程会话不允许设置。取消不删除文件。既有运行冻结旧选择，下一轮读取新选择。
- 默认项目只在本轮没有显式文件夹引用时加入资源。显式文件夹优先，多文件夹仍按原有消歧规则。模型每轮收到当前默认位置/未选择状态，旧对话里的路径不能作为当前默认。
- 选目录不放宽权限、不扫描或索引整目录、不自动运行任务。文件交付沿用声明、确认、写入和读回证据。

## 实施顺序和可执行验收

1. 先新增行为用例：目录规范化/拒绝文件与失效路径；项目默认资源、显式覆盖及清除；scope 保存/重读/隔离/过期 epoch 拒绝。
2. Main 保存目录并返回 scope，Preload 与 Renderer 类型同步。prepare 从 Main scope 取目录；atomic ingress 重读选择，过期准备必须拒绝。
3. 独立 ProjectSelector 组件（按用户补充，外轮廓与模块条共用 38px 高液态玻璃胶囊、19px 圆角及折射/磨砂/边缘高光）：名称/路径搜索、现有工作区和历史会话项目、系统选目录、Ready/Finder 单文件夹拖放、悬停与键盘清除、错误可见。左项目右模块，两者固定 8px 间距；右侧最大限位不变，项目名过长时右端渐隐裁切，短名称完整显示；菜单限制聊天面板。
4. 检查 typecheck、相关行为测试、verify:native、CSS 层级和构建。真实 Electron 以隔离用户数据验证菜单、拖放、取消、切换、布局；目录资源进入现有输出合同并实际落盘。
5. 核对净增长文件和权威运行时说明，保留任务开始时的五处无关改动。

## 边界案例

取消系统对话框不改选择；文件/多个目录/不存在目录报错且保留旧值；异步系统对话框必须绑定打开时的 scope/epoch；关闭或切换后迟到结果不得写入另一个聊天。项目变化发生于 prepare 和 commit 之间必须拒绝旧请求。运行中允许选择下一轮目录，但本轮资源不得变化。

## 验证记录

- `npm run verify:native`：181/181，通过，无跳过；随后更换项目的原子拒绝行为用例单独复跑通过。
- 定向用例（目录与实际导出、选择器、IPC、资源/准备、聊天与玻璃投影）：38/38，通过，无跳过。
- 原生 scope 保存、重读、聊天隔离、过期 epoch 与文件落盘：3/3，通过。
- typecheck、构建、IPC 合同、CSS 层级检查通过。
- 真实 Electron 隔离资料 `/tmp/ready-project-ui-profile`：原生文件拖放、Ready 文件树拖放、无效文件拒绝、菜单、悬停清除、取消、新会话隔离、切回还原和窄窗口不相交通过。重新启动确认保存项目仍存在。
- 实际系统目录对话框经“前往文件夹”选择 `/tmp/ready-project-ui-files`，UI 回显规范目录 `/private/tmp/ready-project-ui-files`。
- 开发阶段的产物验证为本地正式资源/导出入口实际写入和读回，未调用付费模型；后续安装验收见下。
- 用户补充的胶囊材质已接入同一 LiquidLens / LiquidBackdropProjection 与共享 CSS 材质；真实 Electron 浅色、深色均已目视确认并排协调，长名称裁切、菜单点选和取消正常。

- 隔离窗口启用既有 Agent 测试量具时，日志中仍有旧 `skills:askUser:pending` 无处理器提示；新项目选择器不调用该接口，本次未扩大到量具清理。

## 打包与安装验收（2026-09-29）

- 已按用户要求覆盖 `/Applications/Ready.app` 并启动，保留原有聊天、设置和项目选择。短名称贴靠、长名称右侧渐隐及模式胶囊最大限位已在真实窗口确认。
- 打包前修正历史接续测试中写死的过期运行时摘要，改从当前 runtime manifest 独立计算，保留缺失兼容证据必须拒绝的断言；完整打包门禁通过。
- 最终包：Ready 0.8.0 / macOS arm64 / 精简包，335829277 bytes；SHA-256：`a452f06ab67cd64971eb40daa590c82a638ab7a1686b969cbf2dedfe67caa3c9`。校验签名、空 seed、只读挂载及安装内容与包体一致；临时窗口、资料与挂载已清理。
