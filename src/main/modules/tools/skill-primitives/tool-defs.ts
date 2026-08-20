/**
 * Tool definitions for the Phase 1 skill primitives. Mirrors the structure
 * of EXECUTION_TOOL_DEFS — descriptions are hand-authored; param lists are
 * derived from the Zod schemas so field-level description / required flags
 * stay in sync with dispatch-time validation.
 *
 * Pure module — no electron dependency. The descriptions below are the
 * surface the LLM sees, so they are deliberately prescriptive about when /
 * how to call each primitive. Gating happens in skills-tools.ts based on
 * whether the session has a reference-skill hint or an active execution.
 */

import type { SkillToolDef } from '../skill-tool-types'
import { zodObjectToParamList } from '../zod-param-derivation'
import { SKILL_PRIMITIVE_SCHEMAS } from './primitive-schemas'

// Phase 1 PR1 exposed write/read/run-shell. Phase 1 PR2 adds `skill_ask_user`
// (ephemeral execution + renderer capsule + 24h timeout).
export const PRIMITIVE_TOOL_DEFS: SkillToolDef[] = [
  {
    name: 'skill_ask_user',
    description:
      '向用户发起一次澄清问题，暂停当前 skill 直到用户回复。最多 12 个预设选项按钮，用户也可自由输入。只用于一个问题的一组选项；如果需要同时询问 2 个以上问题 / 维度，必须改用 ask_user_questions，让 UI 逐题分页并一次性提交，禁止把多个问题塞进 options。任务已经完成后不要用本工具问用户要不要继续调整，直接在普通总结里一句话询问即可。24 小时无响应自动超时。用于你需要一个关键参数 / 决策而无法从上下文推断时；禁止在已经能自行决策时调用。回复结果通过 tool_result 返回。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_ask_user),
  },
  {
    name: 'skill_compact_context',
    description:
      '压缩当前 Agent 会话的模型上下文。仅在用户明确要求整理/压缩上下文，或当前选中的 context-compact skill 要执行手动压缩时调用；不要把它当作普通任务工具或后台维护动作。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_compact_context),
  },
  {
    name: 'skill_run_shell',
    description:
      '在技能沙箱内执行一次本地程序或 shell 命令。Ready 的飞书 CLI 通道用它执行本机全局 lark-cli，以查询飞书日历、文档、表格和云空间；这不是 Ready 应用内的本地日历。cwd=技能 managedPath；env 注入 CLAUDE_SKILL_DIR（managedPath）与 CLAUDE_SKILL_OUTPUT_DIR（per-skill output 目录）。基础白名单为 python/python3/node/bash/sh/curl/cat/ls/head/tail/grep/find/which/mkdir/pwd/echo/awk/sed；当前技能通过 metadata.requires.bins 或 host_requirements 声明的程序仅在该技能已激活且获执行同意时临时加入。禁止 rm/cp/mv。脚本优先通过 bash scripts/x.sh 或 python scripts/x.py 调用。stdout/stderr 超过 8K 字符会被截断并落到 artifact 文件。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_run_shell),
  },
  {
    name: 'skill_write_artifact',
    description:
      '把字符串写入技能产物。Ready 已冻结目标文件夹时，只接受 declare_completion_criteria 声明过的相对文件路径，首次 expectedVersion=empty，后续必须使用上一条返回的 version；返回逻辑引用和哈希，不返回暂存绝对路径。普通 skill 仍写入自己的 artifact 目录。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_write_artifact),
  },
  {
    name: 'skill_read_artifact',
    description:
      '读取技能产物。Ready 已冻结目标文件夹时，使用相对文件路径和明确 version 读取不可变逻辑版本；普通 skill 仍从自己的 artifact 或任务读根读取。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_read_artifact),
  },
  {
    name: 'skill_export_artifact',
    description:
      '把已暂存产物交付到用户冻结的目标文件夹。Ready 交付必须传 destinationResourceId、targetRelativePath、expectedVersion 和 expectedSha256；目标不同内容时绝不覆盖或改名，成功只认写后回读。普通 skill 可继续使用 targetPath。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_export_artifact),
  },
  {
    name: 'skill_patch_config',
    description:
      '受控修改当前 skill manifest 明确声明可修复的 JSON 配置文件。只能传 host_requirements.config_repair.files 中的 target id/basename/完整路径，支持 JSON pointer set/delete，工具会原子写入、回读校验并 mask key/token/secret。用于用户明确授权“改 key / 改模型 / 清 fallback 后继续”时；禁止用它尝试任意本地路径。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_patch_config),
  },
  {
    name: 'skill_start_detached',
    description:
      '后台启动当前 reference skill 的 typed action，立即返回 taskId；适合耗时较长、无需当前 LLM turn 一直等待的技能任务。后续用 skill_inspect_detached 查看状态。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_start_detached),
  },
  {
    name: 'skill_inspect_detached',
    description:
      '查看 skill_start_detached 返回的后台任务状态，包括 status、outputDir 和该技能返回的结构化输出路径。用户说“继续”且已有后台 taskId 时优先调用。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_inspect_detached),
  },
  {
    name: 'skill_cancel_detached',
    description:
      '取消 skill_start_detached 返回的后台任务。仅在用户明确要求停止对应后台技能任务时调用。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_cancel_detached),
  },
  {
    name: 'skill_inspect_run_state',
    description:
      '检查 skill 输出目录里的 run_state.json，返回结构化的 currentStage / totalScenes / completedScenes / coverageRatio / activeOutputDir / taskId / expectedTaskId / waitingFor / lastError + 截断后的 raw JSON。续做长流程任务（VEA pipeline 等）时优先调用，不要靠 skill_read_artifact 自己 parse。outputDir 与 taskId 二选一：传 taskId 自动解析后台任务的 outputDir；同一目录有多个 run_state 时传 expectedTaskId 防止误选。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_inspect_run_state),
  },
]

export const PRIMITIVE_TOOL_NAMES: ReadonlyArray<string> = PRIMITIVE_TOOL_DEFS.map(
  (def) => def.name,
)

export const PRIMITIVE_TOOL_NAME_SET: ReadonlySet<string> = new Set(PRIMITIVE_TOOL_NAMES)
