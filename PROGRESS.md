# Ready 当前进展

> 核对日期：2026-09-06。源码基线为 `b3dd9f73`，本页依据当前代码、清单与已提交记录；文档核对不等于再次打包或全量真机验收。

## 1. 当前基线

- 应用 0.8.0，Electron 42.3.0，固定 Codex runtime 0.149.0；版本以 `package.json` 与 `assets/codex-runtime/runtime-manifest.json` 为准。
- 四个工作面：Browser、Document、RSS、Calendar；跨工作面的单一 Ready 助手、文件、技能、MCP、手动长期记忆和远程助手。
- Agent 生产入口为 `CodexHostOrchestrator`，经原生回合与统一结果保存呈现。旧 SDK 模型循环、Dynamic Delivery/Boost、专项人格、旧记忆和 Agent 定时任务均已退役。
- 当前发布配置是 macOS arm64。精简包不内置技能运行时；完整包需要单独置备并核对运行时清单。

## 2. 最近已进入源码的变化

| 变化 | 当前行为与边界 | 证据入口 |
| --- | --- | --- |
| 历史续聊和草稿恢复 | 统一判断旧历史可否接续；阻断时仍可编辑草稿，并按当前资格保留记录、开始新上下文。重播过的尾项不会再次带入 | `d6554bc5`；`docs/superpowers/plans/2026-09-03-ready-history-continuation-and-composer-repair-implementation.md` |
| 已有数据升级 | 保留旧网关记录的未知字段，新请求仍要求完整证据；避免把新约束反向套到旧记录导致启动失败 | `7f6e378b`；`docs/superpowers/plans/2026-09-03-ready-populated-upgrade-migration-implementation.md` |
| 微信/飞书远程助手 | 本人绑定后的文字任务进入当前助手；先保存再确认收信，按线程处理，未知发送结果不会自动重发 | `0d5a3223`；`docs/superpowers/plans/2026-09-05-remote-im-reliability-implementation.md` |
| 书本阅读 | 改善纸张弯曲、透印、落页和纸堆厚度；背景可跟随主题或保存自选色，并减少翻页重复布局 | `b3dd9f73`；`docs/superpowers/plans/2026-09-05-document-reading-paper-implementation.md` |
| 发布来源核对 | 编译前记录实际源码，打包和复制沿用同一来源记录；相同版本号不再足以证明是同一个包 | `d6554bc5`；`Packer/README.md` |
| 单一助手与长期记忆 | 手工增删改、固定、读取与撤销已接通；自动整理暂不开放 | `src/main/modules/agent-control/ready-memory/`、`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx` |

## 3. 验收边界

- 历史续聊的 2026-09-05 交付记录包含绑定具体包体的安装验收；它早于后续远程通信与阅读提交，不能证明最新整包也已验收。具体记录见 `outputs/history-delivery-20260905/acceptance.md`，属本机输出，不要求源码接收方拥有。
- 阅读计划记录了 61 项阅读测试、原生数据库和真实 Electron 对照；固定长文夹具的性能结论不推广为所有文档、所有硬件或当前新包的结论。
- 远程计划记录了本地协议夹具与隔离应用验收；真实微信/飞书账号、对外发送和最终安装包有各自的验收边界，以该计划末尾记录为准。
- 本轮只更新项目文档、导航与归档。实际运行的文档检查及范围见 `docs/maintenance/2026-09-06-documentation-refresh.md`。

## 4. 当前未开放或不能据此宣布完成的能力

- 长期记忆自动整理：生产提供方明确返回不可用，不自动发起模型整理请求。
- Windows 发行：仍缺目标平台 Codex 资产、打包和本机验证；见 `docs/platform/windows-development.md`。
- 任意技能脚本、旧 child-loop 与公开子任务续跑：技能存在或有历史句柄不代表当前 Codex 已支持执行。
- Agent 定时任务、旧专项 Agent 与旧人格不是待恢复入口。领域技能与资料库旧提案不能覆盖单一 Ready 与新记忆事实。
- 更新 runtime、换模型、压缩或失败重试均有独立资格，不能把一项通过推导为其他历史操作都可用。

## 5. 从哪里继续

从 `docs/README.md` 选择现行合同和对应检查；所有项目叙述文档的去向见 `docs/documentation-inventory.md`。旧计划中的“待开工”“当前缺口”“已通过”只描述记录当时的状态，不能据此安排本次开发或宣布发布。
