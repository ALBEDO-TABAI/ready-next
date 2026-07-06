---
status: P0 收口 — 白 2026-07-07 授权全案施工；本篇记录 P0 四单 + 对抗性审查修复循环结果
owner: 白
author: Claude (Opus 4.8)
enforce: false
note: >
  母合同 2026-07-06-skill-envelope-floors-and-standard-adoption-implementation.md §5 P0；
  执行书 2026-07-07-skill-envelope-p0-unblock-implementation.md。本篇是留档，不是合同。
---

# P0 收口：解除 skill 工具封锁（含对抗性审查修复循环）

## 1. 结论
2026-07-06 真机失败轮（`@[ready-human-touch-ppt]` + `@[*.md]` → `toolCount=0 tools=none`）的
三层缺陷 D1/D2/D3 已修复；技能选中 + 本地文档同轮的工具面在代码层证明可用（8 工具，含
`skill_read_artifact`/`skill_run_shell`/`file_read_excerpt`，无空面回退）。全量 `test:parallel`
6644 测试 0 失败；`typecheck` 绿。

**唯一未完成项**：交互式真机 dogfood（P0-4 §5 的 `npm run dev` + 真模型回合真正写出 HTML）。
自动化代理已在代码层证明工具面机制通，但真模型端到端回合需要用户在真机执行——见交付的测试文档。

## 2. 提交序（分支 feature/skill-envelope-floors）
| commit | 内容 |
|---|---|
| 90fb5f98 | 注册 ready-human-touch ppt/card 嵌入式技能 + 计划文档（P0-1 A） |
| 3749795e | D1：显式技能 mention 穿透附件上下文标记（P0-1 B） |
| 7d730190 | D2：本地文档收窄保技能地板 + 空面回退（P0-2） |
| ca294171 | D3：技能轮保留文档读取地板（P0-3） |
| c482a00c | P0-4 自动化 dogfood 代理 |
| 8059843a | 对抗性审查修复：空面回退安全化 + D2 收窄真路径测试 |

## 3. 对抗性审查（4 个独立视角 + 1 次 fix-delta 复核）
Codex CLI 本机未安装，独立外审以具名 Claude 子代理补位（母指引"外部复审无输出必须替代补位"）。

| 视角 | 结论 |
|---|---|
| 正确性/回归 | 无 blocker；最尖锐的"回退撤销 S4-2"假设被端到端**证伪**（file_management 组 15 个 file_* 工具令面永不空）。 |
| 合同/架构 | 无 blocker/major；两 minor（回退形态、arbitration-空面）均 P1 已排期。 |
| 测试质量 | **BLOCKER**：D2 orchestrator 接线无测试守护——把真实收窄改回 bug 版全绿。 |
| Codex 替身裁决 | DON'T SHIP(narrow)：回退撤销 S4-2 的**机制**成立（predicate 层可共触发），单一环节未证。 |

### 冲突裁决
"回退是否撤销 S4-2"上，正确性视角（驱动真实 `listDefaultToolDefinitionsForTurn`）证伪了可达性：
本地文档收窄保留全部 `domain==='file'` 工具（file_management 组），面永不空 → 回退永不触发。
故安全违规**当前不可达**，但耦合是 latent，四视角一致建议同一修法。

## 4. 已应用修复（commit 8059843a）
1. **回退安全化（根因修）**：`recoverEmptyToolSurface` 从"checkpoint 之后"上移到"本地文档收窄之后、
   S4-2/documentTargetGuard/checkpoint 之前"。这些安全/定向/续跑收窄现在**始终在回退后的面上最后生效**，
   回退在结构上不可能再撤销它们（不再依赖 file_management 偶然保面）。
2. **D2 收窄真路径测试（解 BLOCKER）**：抽出 `narrowToolSurfaceForLocalDocument`（orchestrator 唯一调用点），
   floor 单测 + P0-4 代理改为直接调用**真实函数** + 负载用例（必须被丢的 browser 工具 / 触发回退的纯 browser 面 /
   none 轮无原语泄漏）。把真实函数改回 bug 版 → floor 测试与代理测试双双变红（已复验 break→red→restore）。

## 5. 明确延后到 P1（已在 commit body / 本篇留档，非遗漏）
- **orchestrator 地板 vs 执行器 manifest `allowed_tools`**（正确性视角 #2）：orchestrator 地板取
  `typedActions ∪ primitives`，执行器另可取 skill 的 manifest `allowed_tools`。当前两个出厂技能均未声明
  `allowed_tools`，两者相等，不可达；P1-3 `computeCapabilityFloors` 统一唯一裁决面时自然收编。
- **arbitration 自身产出空面 → 仍可能零工具开跑**（合同视角 MINOR-2）：回退仅在"收窄前非空"时触发；
  若 `listToolDefinitionsForTurn` 本身返回空，回退不触发。P1 T2 的"无条件 `surface ≠ ∅` 不变量"收口。
- **`shouldSuppressSkillAskUserForArtifactDelivery` 正则**（正确性视角 #3，MINOR）：`(?:…)?目录下|文件夹下`
  可选前缀会命中疑问句"…在哪个目录下？"，在选中技能轮误抑制 `skill_ask_user`。低影响、且属 D1 既有启发式；
  收紧会扰动已验证的 14/14 parity，暂留观察。

## 6. 验证证据
- 焦点：`skill-doc-toolset-floor`（6/6）、`skill-doc-dogfood-proxy`（含负载用例）、
  `sdk-turnengine-capability-parity`（15/15）、`agent-sdk-runtime`（89/89）、
  `skill-tool-gating-by-session` + `tool-policy-authorization`（33/33）全 EXIT=0。
- 全量：`npm run test:parallel` = 6644 tests / 0 fail / 232 skip（skip 为 host-Node better-sqlite3 ABI，`verify:native` 覆盖）。
- `npm run typecheck` = EXIT 0。
- P0-4 代理实测工具面（8）：`document_read_section[document]`, `file_locate[file]`,
  `file_read_excerpt[file]`, `skill_run_shell`, `skill_write_artifact`, `skill_read_artifact`,
  `skill_export_artifact`, `skill_inspect_run_state`；`recovered=false`。

## 7. 交给用户的验收（真机 dogfood，见测试文档 P0 段）
`npm run dev` → agent 对话输入 `使用@[ready-human-touch-ppt]根据@[<任一 md>]生成人文感 ppt，输出到同一目录`
→ 核 `$TMPDIR/ready-tools.log` 末行 `sdk_runtime_final_tools`：`toolCount≥7`、含三工具、无
`sdk_runtime_empty_surface_recovered`；且真出 HTML 到目标目录。
