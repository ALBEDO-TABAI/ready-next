# Ready 当前进展

> 核对日期：2026-09-29。应用行为依据已提交源码 `e5e4cff0`，另纳入本次已验证的测试清扫；其他会话进行中的工作区修改不作为已交付能力。文档核对不等于再次打包或全量真机验收。

## 1. 当前基线

- 应用 0.8.0，Electron 42.3.0，固定 Codex runtime 0.149.0；版本以 `package.json` 与 `assets/codex-runtime/runtime-manifest.json` 为准。
- 四个工作面：Browser、Document、RSS、Calendar；跨工作面的单一 Ready 助手、文件、技能、MCP、手动长期记忆和远程助手。
- Agent 生产入口为 `CodexHostOrchestrator`，经原生回合与统一结果保存呈现。旧 SDK 模型循环、Dynamic Delivery/Boost、专项人格、旧记忆和 Agent 定时任务均已退役。
- 当前发布配置是 macOS arm64。精简包不内置技能运行时；完整包需要单独置备并核对运行时清单。

## 2. 最近已进入源码的变化

| 变化 | 当前行为与边界 | 证据入口 |
| --- | --- | --- |
| 历史续聊和草稿恢复 | 阻断时仍可编辑草稿；可恢复失败保留记录开始新上下文。固定运行时已证明的零输出额度拒绝保留原 thread 和普通发送资格，不自动重发；终态按实际发送内容的回读形态核对 | `a68c9a43`、`e5e4cff0`；`docs/superpowers/plans/2026-09-03-ready-history-continuation-and-composer-repair-implementation.md` |
| 聊天项目目录 | 每个本地聊天保存自己的默认交付目录；显式文件夹引用优先，远程会话不设置项目，选目录不放宽权限或自动扫描文件 | `74ebfa98`、`c387072f`；`docs/superpowers/plans/2026-09-29-chat-project-selector-implementation.md` |
| 第三方模型接入 | 同一 Codex 网关承接 Responses、Chat Completions、Messages；连接测试复用正式接入路径。Z.ai 与 Opus 的已验证配置见专门记录 | `c16d5e13`；`docs/superpowers/audits/2026-09-26-provider-adapters-validation.md` |
| 接入模块拆分 | HTTP、协议转换、流校验、凭据过滤与数据库访问按职责分开，保留公开入口及同一授权边界 | `6a8199ad`；`docs/superpowers/plans/2026-09-26-model-gateway-modularization.md` |
| 工作台性能与菜单 | RSS 按可见窗口渲染；历史动作面和技能目录减少重复读取；聊天菜单随面板边界布局 | `1e9585c3`、`15aed89d`、`98c06c55`；`docs/superpowers/plans/2026-09-22-workbench-switch-performance-implementation.md` |
| 测试维护 | 退役与空转测试清理，保留有效覆盖并补真实失败路径；界面合同进入默认套件，E6 使用独立环境 | `docs/superpowers/audits/2026-09-29-test-suite-cleanup-checklist.md` |
| 已有数据升级 | 保留旧网关记录的未知字段，新请求仍要求完整证据；避免把新约束反向套到旧记录导致启动失败 | `7f6e378b`；`docs/superpowers/plans/2026-09-03-ready-populated-upgrade-migration-implementation.md` |
| 微信/飞书远程助手 | 本人绑定后的文字任务进入当前助手；先保存再确认收信，按线程处理，未知发送结果不会自动重发 | `0d5a3223`；`docs/superpowers/plans/2026-09-05-remote-im-reliability-implementation.md` |
| 书本阅读 | 保留纸张与背景改进；大图完整缩放，达到阈值后独页，后文从下一页接续；图片测量与页面展示使用同一尺寸 | `b3dd9f73`、`0d210e62`；`docs/superpowers/plans/2026-09-15-document-reading-images-implementation.md` |
| 发布来源核对 | 编译前记录实际源码，打包和复制沿用同一来源记录；相同版本号不再足以证明是同一个包 | `d6554bc5`；`Packer/README.md` |
| 单一助手与长期记忆 | 手工增删改、固定、读取与撤销已接通；自动整理暂不开放 | `src/main/modules/agent-control/ready-memory/`、`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx` |

## 3. 验收边界

- 历史续聊的 2026-09-05 交付记录包含绑定具体包体的安装验收；它早于后续远程通信与阅读提交，不能证明最新整包也已验收。具体记录见 `outputs/history-delivery-20260905/acceptance.md`，属本机输出，不要求源码接收方拥有。
- 阅读计划记录了 61 项阅读测试、原生数据库和真实 Electron 对照；固定长文夹具的性能结论不推广为所有文档、所有硬件或当前新包的结论。
- 远程计划记录了本地协议夹具与隔离应用验收；真实微信/飞书账号、对外发送和最终安装包有各自的验收边界，以该计划末尾记录为准。
- 9/26 三个模型配置完成真实隔离窗口的文档工具调用和续聊，Opus 另验重启与停止；仅适用于 `docs/superpowers/audits/2026-09-26-provider-adapters-validation.md` 记录的配置。Kimi、MiMo、MiniMax 和全部视觉能力不能据此宣布真实验收通过。
- 9/22 工作台性能、9/29 项目目录已有各自绑定包体的安装记录，见对应计划；它们不代表本次测试清扫后的整包已重新构建或安装。
- 本次测试清扫的普通套件零失败；原生数据库 191/191、完整脚本测试 996/996，E6 隔离回归 30/30。7 条既有代码检查告警仍在，旧字母阶段链未整体重整；完整边界见测试清理审计 §10。

## 4. 当前未开放或不能据此宣布完成的能力

- 长期记忆自动整理：生产提供方明确返回不可用，不自动发起模型整理请求。
- Windows 发行：仍缺目标平台 Codex 资产、打包和本机验证；见 `docs/platform/windows-development.md`。
- 任意技能脚本、旧 child-loop 与公开子任务续跑：技能存在或有历史句柄不代表当前 Codex 已支持执行。
- Agent 定时任务、旧专项 Agent 与旧人格不是待恢复入口。领域技能与资料库旧提案不能覆盖单一 Ready 与新记忆事实。
- 更新 runtime、换模型、压缩或失败重试均有独立资格，不能把一项通过推导为其他历史操作都可用。

## 5. 从哪里继续

从 `docs/README.md` 选择现行合同和对应检查；所有项目叙述文档的去向见 `docs/documentation-inventory.md`。旧计划中的“待开工”“当前缺口”“已通过”只描述记录当时的状态，不能据此安排本次开发或宣布发布。
