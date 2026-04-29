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
      '向用户发起一次澄清问题，暂停当前 skill 直到用户回复。最多 12 个预设选项按钮，用户也可自由输入。24 小时无响应自动超时。用于你需要一个关键参数 / 决策而无法从上下文推断时；禁止在已经能自行决策时调用。回复结果通过 tool_result 返回。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_ask_user),
  },
  {
    name: 'skill_run_shell',
    description:
      '在技能沙箱内执行一次 shell 命令。cwd=技能 managedPath；env 注入 CLAUDE_SKILL_DIR（managedPath）与 CLAUDE_SKILL_OUTPUT_DIR（per-skill output 目录）。支持 cd、$VAR、&&、管道、重定向、bash/sh 包裹的 POSIX 单引号写法，以及 python/node/grep/find/awk/sed 这类脚本探针里的单引号片段；受白名单限制，只允许 python/python3/node/bash/sh/curl/cat/ls/head/tail/grep/find/which/mkdir/pwd/echo/awk/sed，禁止 rm/cp/mv。脚本优先通过 bash scripts/x.sh 或 python scripts/x.py 调用。stdout/stderr 超过 8K 字符会被截断并落到 artifact 文件。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_run_shell),
  },
  {
    name: 'skill_write_artifact',
    description:
      '把字符串写入技能 artifact 目录（<outputsRoot>/<skillId>/）下的相对路径。禁止绝对路径 / .. / symlink 穿越 / 保留文件名（SKILL.md、ready-skill.json、skill.workflow.json）。同名文件允许覆盖。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_write_artifact),
  },
  {
    name: 'skill_read_artifact',
    description:
      '从技能 artifact 目录（<outputsRoot>/<skillId>/）读取文件。优先传相对路径；如果上一条 skill_run_shell 返回了该目录内的绝对日志路径，也可以直接传入。默认最多读取 32K 字符，超出部分会被截断并标注 truncated=true。若要读取技能 bundled 的脚本 / 模板，请用 skill_run_shell 的 cat 命令。',
    kind: 'primitive',
    params: zodObjectToParamList(SKILL_PRIMITIVE_SCHEMAS.skill_read_artifact),
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
