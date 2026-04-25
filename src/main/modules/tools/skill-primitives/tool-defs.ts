/**
 * Tool definitions for the 4 Phase 1 skill primitives. Mirrors the structure
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
      '在技能沙箱内执行一次 shell 命令。cwd=技能 managedPath；env 注入 CLAUDE_SKILL_DIR（managedPath）与 CLAUDE_SKILL_OUTPUT_DIR（per-skill output 目录）。支持 cd、$VAR、&&、管道、重定向、bash/sh 包裹的 POSIX 单引号写法，以及 python/node/grep/find/awk/sed/yt-dlp/scenedetect 这类脚本探针里的单引号片段；受白名单限制，只允许 python/python3/node/bash/sh/curl/cat/ls/head/tail/grep/find/which/mkdir/pwd/echo/awk/sed/yt-dlp/ffmpeg/ffprobe/scenedetect，禁止 rm/cp/mv。脚本优先通过 bash scripts/x.sh 或 python scripts/x.py 调用。stdout/stderr 超过 8K 字符会被截断并落到 artifact 文件。',
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
]

export const PRIMITIVE_TOOL_NAMES: ReadonlyArray<string> = PRIMITIVE_TOOL_DEFS.map(
  (def) => def.name,
)

export const PRIMITIVE_TOOL_NAME_SET: ReadonlySet<string> = new Set(PRIMITIVE_TOOL_NAMES)
