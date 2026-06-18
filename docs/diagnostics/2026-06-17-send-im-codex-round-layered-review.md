# Findings — send-im / 发图到微信 失败（Codex 一轮修复后的深审）

> 诊断日期：2026-06-17 晚 ｜ 工具：ready-debug + 三路并行代码审查 + 账本核验 ｜ 分支：agent-evolution/phase1
> 方法：先取证（日志/账本）→ 三路 reviewer（暴露/执行/横切）→ 自核验判定器是否真改判 → 排层。
> 状态：仅诊断，未改代码。typecheck 通过（exit 0）。

## 端到端失败链（截图那次 + 20:05 那次）

用户：`@[Send IM] 把这四张图发到我微信`（4 张图已由浏览器下载到 `…/07-项目验证与网页抓取/`）。

- **暴露层**：`@[Send IM]` 附着**没有为本轮授权 send-im**。14:14/14:24 两次 run 工具列表里 **0 个 `skill_*`**（toolCount 78/56），模型只能回"没有 skill 执行工具"。证据：`tool_capability final_tools` 快照无任何 skill 工具；`run_close terminalReason=adjudication_degraded toolCallsUsed=0`（ckxwcl）。
- **即便暴露（20:05 run 78euqa，工具列表含 `skill_send_im_send_file` 并被调用 2 次），两道坎叠加**：
  1. **文件解析失败**：4 张下载图既不在 `requestEnvelope.resources`（只收 composer 附件/引用），也未被 `@[]` 提及（本轮 `@[]` 只有 "Send IM" 技能名）→ `file_not_found` → 模型在两次发送之间 `file_search/file_inventory` 重试。
  2. **判定层结构性必败**：调用 `skill_*` → 任务行 `module='skill'` → 追加 `skill` overlay 准则 **s1**（`run_state.json 终态 done 且 delivery_report 存在`）→ direct-mode 的 send-im 直接返回 `ToolExecutionOutput`、**永不写 run_state.json/delivery_report** → s1 永远不满足 → run 被改判 `adjudication_degraded` → 本地路径上抛通用串 `Agent execution failed`。证据：`78euqa … blockers:["criteria_unsatisfied:s1"] … terminalReason:adjudication_degraded`。

## 问题层级（按爆炸半径与依赖排序）

### L0 系统级（先于功能、爆炸半径最大）
- **Problem A（UI 卡死/停止失效）Codex 本轮未碰，仍在。** `runtimeDriver.ts` / `ipc-handler.ts` 不在 diff 中；renderer 仍只靠实时终态事件清 `isStreaming`、无 projection 对账兜底。
- **判定器过严（待定是否本轮新引入）**：今天 23 个 closed run 里 **9 个**被改判 `adjudication_degraded`，含一个 0 工具的"直答"（ckxwcl）。`adjudicator_shadow_divergence` 命名像 observe-only，但 `run_close` 实际把 done 改成了 adjudication_degraded（昨天 gdnx3e 同类 base 准则未改判、今天会改判，疑似近期从 shadow 改成 enforce）。**direct-skill 的 s1 改判已确证为 bug**；整体过严属系统性观察项，需确认 new-vs-baseline。

### L1 功能阻断（send-im 要能用必须修，确证）
- **D1（keystone）判定 overlay vs direct-mode skill**：s1 准则是给 child-loop/python 长任务（写 run_state.json，如 video-expert）设计的；send-im 是首个 "direct、纯工具" skill，落进同一 overlay 却永远满足不了 → 每次必败。修向：direct-mode/tool-only skill 不 stamp `module='skill'`，或 s1 对 direct 执行成功的 tool_result 视为满足/不适用（`markNotApplicable` 当前 0 调用方）。**Codex 新增 direct skill 时未与既有 skill 准则对账。**
- **暴露：`@[skill]` 附着不为 direct skill 授权本轮**。live 授权只认本轮文本经 `findExplicitlyRequestedSkills` 触发；`@[Send IM]` 提及被抽走后，剩余文本"把这四张图发到我微信"既无 "Send IM" 字面 token、四图也非 `@[文件]` → `no_skill_signal` → 砍掉所有 `skill_*`。direct skill 不是 reference-like，不进 reference-hint 也无 sticky active-context。修向：`@[skill]` 附着给 direct skill 一个 per-turn/sticky active-skill-context，或放宽 `hasLocalSendImFileIntent`/选择逻辑。
- **D2 文件解析 + 多文件**：下载文件不进 resource 层；`selectResource` 仅在精确名匹配或 `resources.length===1` 时返回；多文件无 fan-out（单次单文件，SKILL.md 也没说要发 N 次）。修向：接受多路径/目录+glob；多候选返回结构化 disambiguation；下载产物落 resource 层。

### L2 正确性 / 潜伏陷阱（确证，当前 latent）
- **工具名三处不一致**：live 路径自洽用 **`skill_send_im_send_file`**（`buildToolName` 读 `STATIC_TOOL_NAMES`，其中**无** send-im 条目，回退默认名）；Codex 把 `skill_send_im_file` 加到了**另一张表** `STATIC_SKILL_TOOL_NAMES_BY_ACTION`，且 manifest `allowed_tools` 与 SKILL.md 都写 `skill_send_im_file`。今天无害（live 不读 allowed_tools，dynamic 名自洽），但：① SKILL.md 让模型叫 `skill_send_im_file` → 若模型照做则 `tool_not_registered`；② 一旦 policy/turn-engine 路径启用，`filterToolsByAllowedTools` 会按错误名把工具清零。修向：把 `'send-im:send_file':'skill_send_im_file'` 也加进 `STATIC_TOOL_NAMES`（或合并两张重复表），manifest/SKILL.md/测试统一到同一个名。

### L3 测试诚信 / 卫生（确证）
- **两个测试 pin 了错误工具名 / 不走 live 路径，绿但假**：`tool-registry-skills-dynamic-resolution.test.ts` 靠"让 dynamic 抛错"走 static fallback 才断到 `skill_send_im_file`；`skill-context-orchestrator.test.ts` 直接 hardcode `resolveSkillToolByAction` 返回 `skill_send_im_file`。两者都不会发现 live 实际暴露名是 `skill_send_im_send_file`，也抓不到暴露丢失。`send-im-skill-tool.test.ts` 直接调 `executeSendImFileTool`、手喂单 resource，绕过暴露/授权/判定/多文件——只覆盖唯一能成的路径。
- **silent-catch gate 违规**：`send-im-skill-tool.ts:297` 的 catch 功能上返回结构化 `send_failed`（不算对模型静默），但缺注释/日志，被 `check-silent-catch.cjs` 命中（该 gate 在 base 上已红）。

### L4 未验证（需真机微信）
- 微信附件 `image_item` 上传协议：`mid_size` 用了密文/填充长度、`no_need_thumb:true`，与 file 用 raw `len` 不同——协议正确性未经真机验证。
- send-to-self 依赖 `to_user_id==self` 假设（无 filehelper 兜底）；inbound 附件下载 `except Exception: return None` silent drop（仅入站）。

## Problem B（okf-bundle）状态：部分修复
commit `ff92577e` 加了 `explicitReferenceSkillHasScripts()`：reference/advisory skill 若无 typed action 但有 `scripts/` 目录，则放行 `skill_run_shell`(+`skill_write_artifact`/`skill_read_artifact`)。但 okf-bundle 仍产不出知识包：① `okf_tools.py` 只 validate/scan/index，**不创建 bundle 目录或概念 .md**；② `SKILL.md` 命令"实际创建知识包文件夹并写 .md"却**从没提 `skill_write_artifact`/`skill_run_shell`**，给的是裸 `python …/okf_tools.py` 与假定的环境文件系统写。即 runtime 现在"给"了 primitive，skill 指令没"用"。**partial fix。**

## 三路 reviewer 分歧的澄清
- 暴露 reviewer 与横切 reviewer 判"名字不一致是 latent、功能基本能用"——对 live 工具层正确。
- 执行 reviewer 找到真正的 run 失败因（s1 overlay，D1）——经账本核验确证。
- 三者不矛盾：**名字=潜伏陷阱（L2）；调用后必败=s1 overlay（L1/D1）；压根没暴露=`@[skill]` 不授权本轮（L1 暴露项）**，是三层不同问题。

## 建议处理顺序
1. **D1（keystone）**：解掉 direct-skill 的 s1 必败——最小改动、解锁整个功能。
2. **暴露**：`@[skill]` 附着为 direct skill 授权本轮。
3. **D2**：下载产物落 resource 层 + 多文件 fan-out/结构化 disambiguation。
4. **名字统一（L2）+ 修两个假测试（L3）**：cheap，去潜伏陷阱、恢复测试诚信。
5. **L0 另行决策**：Problem A 收口兜底 + 判定器过严复核（架构级，单独排）。
