---
title: Agent/Skill 复审缺口收口实施契约
date: 2026-07-10
kind: implementation
enforce: true
status: implemented
depends_on:
  - 2026-07-09-chained-skill-envelope-round2-implementation.md
  - 2026-07-09-agent-skill-module-residual-optimization-implementation.md
  - 2026-07-10-s4-5-evidence-step-completion-implementation.md
verify_entry: npm run verify:skill-envelope-write && npm run verify:streaming && npm run verify:context-instrumentation && npm run verify:stability && npm run verify:browser-reliability && npm run verify
---

# Agent/Skill 复审缺口收口

## 完成合同

本实施只处理 Agent/Skill 主线与阻断全量验收的仓库卫生问题。Packer、工具时间线及其他无关功能不在范围内。

必须同时满足：

1. 技能目录压缩去重不删除用户/助手消息。
2. 链式只读根以真实路径证明仍位于 outputsRoot，symlink 不得越界。
3. 未知 Anthropic 模型默认输出上限为 4096，用户可在现有模型配置中覆盖。
4. provider 压缩前账单只作诊断，估算/实耗对账只使用真实上行输入。
5. finalizer 显式终态 taskType/budget 不被陈旧 projection 行覆盖。
6. S4-5 只以绑定句柄、终态和完整数量证据推进。
7. agent-sdk-utils 为薄 facade 且叶子模块无回边；turn orchestrator 保留能力地板最终裁决并完成职责拆分。
8. 冲突标记与 SQLite gate 清零；原生、专项、全量、构建与真实 Electron 事故复跑全部通过。
9. 外部复审有输出且高/中优先级问题清零；所有增加行数的代码文件完成行数健康检查。

## 执行顺序

先恢复可测试基线，再依次完成安全/正确性修复、S4-5、SDK 拆分、全链验证和真机验收。任何历史文档只有在最终证据齐全后才能恢复 `implemented`。

## 2026-07-10 最终收口证据

- 九类功能、安全、计量、终态与架构缺口均已落地；目录消息、跨技能只读根、模型输出上限、真实上行账单、终态事实优先级和 S4-5 严格证据均有行为回归。
- SDK 内部已拆分：`agent-sdk-utils.ts` 8 行，provider 937 行，orchestrator 958 行，turn execution 897 行，tool executor 922 行，model loop 799 行；叶子模块回依赖 gate 通过。
- 真实 Electron 复跑通过：`req-1783691683388-35og4e` / `task-6d7fea46-7425-4bee-9218-8abd55717790`，显式引用 `image-reverse-describe` 和 `image-deep-read`，两份产物分别 10800/12973 bytes，`delivered=2, expected=2`，`run_close terminalReason=done`。证据在 `docs/superpowers/audits/2026-07-10-skill-review-closeout/electron-20260710-215500/`。
- 真机前三次未通过均保留为反例：首次发现 `/tmp` 与 `/private/tmp` 交付别名，第二次证明终态修复后的安全拒绝，第三次暴露测试未形成 typed 技能引用；最终用真实显式引用复跑通过，未降低验收标准。
- 命名对抗复审：Ramanujan（功能/安全）、Tesla（运行态/续跑）、Huygens（验证合同）均返回明确结论，最后一轮无高、中优先级遗留。
- 最终命令链通过：静态边界/SQLite/冲突检查、`typecheck`、`native:check`、`verify:native`、`verify:skill-envelope-write`、`verify:streaming`、`verify:context-instrumentation`、`verify:stability`、`verify:browser-reliability`、`npm test`、`npm run verify`、`npm run build`。日志在 `docs/superpowers/audits/2026-07-10-skill-review-closeout/final-validation/`。
- 行数复核已完成；超过 1000 行且本轮增长的文件已更新 `docs/code-health/large-file-health-log.md`。
