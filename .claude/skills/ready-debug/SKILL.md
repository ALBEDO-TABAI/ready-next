---
name: ready-debug
description: 定位 Ready 的设置或历史异常、Agent 无回复和浏览器采集故障；用于可检查应用、源码和日志的排障任务。
---

# Ready 故障排查

用于外部编码代理排查 Ready。先确认故障来自安装版还是开发版，记录复现动作、发生时间与应用路径；按症状选择下表入口，不逐项通读所有日志。

## 范围与完成条件

- 用户要求修复时，完成定位、范围内修复、对应检查和复现动作回测；不再询问“现在修还是只出报告”。只要求诊断或明确不改代码时，交付原因、证据和可执行建议。
- 既有草稿、历史、配置和用户资料必须保留。不得把清空数据库、重置会话、开始新上下文当作默认排障步骤；需要这些动作且尚未授权时，先准备具体方案再询问。
- 修复安装版症状时，源码测试通过只证明源码。应在用户实际使用的目标上验证；若替换安装包或重启会影响正在进行的工作且未获授权，说明剩余动作，不冒称已修好。

## 从症状选入口

日志位于目标进程的 `os.tmpdir()`：macOS 通常为 `$TMPDIR`，Windows 通常为 `%TEMP%`。只提取与本次故障相关的片段，不展示凭据或无关对话。

| 症状 | 起点与继续核对的证据 |
| --- | --- |
| 设置丢失、历史空白、scope not found | `ready-database.log` 的加载/迁移错误；有数据库线索再读[存储排查](references/storage.md)，没有线索则沿当前会话与读取入口查 |
| Agent 无回复、一直运行或完成但无反馈 | `ready-directchat.log` 的当前 run/thread/turn 身份、终态与投影；工具报错时补 `ready-tools.log` |
| 采集结果为空、浏览器动作或弹窗异常 | `ready-browser.log` 与对应工具结果，核对真实页面、当前任务的采集结果和完成证据 |
| 旧任务内容串入新任务 | 当前 scope、上下文代次、输入资源和历史接续证据；只读同一任务的相关日志，不因旧 metrics 中有内容就认定当前已注入 |

发现一条错误后继续核对它能否解释复现动作与相邻入口；时间接近或错误文字相似不足以证明同一根因。

## 当前调用链与按需资料

Agent 当前入口是 `CodexHostOrchestrator`，终态经 `ReadyCodexLifecycleAdapter` 与 canonical closeout 收口。先追 Main 的运行与持久状态，再核对 Renderer 展示；不能只凭页面沉默判定任务死亡。

- 涉及 Agent、工具授权或历史接续，读[当前运行时合同](../../../docs/architecture/current-runtime-contracts.md) §2、§3、§5 的相关条目。
- 涉及采集、BrowserView 或任务完成，读同一合同 §1、§6；只有对应任务确实使用某张账本时才查询。
- 定位代码入口时用[代码地图](../../../docs/architecture/codebase-map.md)；选择验证时用[测试规约](../../../docs/superpowers/testing-conventions.md)。

`AgentSdkRuntime`、旧 `ready-agent-sdk.log`、旧 belief metrics 与 child-loop 账本只作为历史/支撑线索；不得用它们恢复已退役主链、制造公开续跑，或覆盖当前 Codex 真值。

## 交付

用简单语言说明症状、已确认原因、修改与验证结果、仍需用户介入的真实障碍。区分已证实、推断和未验证；仅在用户需要报告或证据量较大时生成 `findings.md`，不强制五段模板。
