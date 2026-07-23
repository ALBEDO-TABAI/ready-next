/**
 * Zod schemas for the 4 Phase 1 skill primitives. Kept separate from the tool
 * defs so dispatch validation can look them up by tool name, and so the
 * static schema registry in `tools/schemas/index.ts` has a single import
 * surface. Each param gets a `.describe()` call so the Zod → param-list
 * derivation carries rich descriptions through to the LLM-facing schemas.
 */

import { z } from 'zod'

const TRIMMED_STRING = z.string().trim().min(1)

export const SKILL_PRIMITIVE_SCHEMAS = {
  skill_ask_user: z.object({
    question: TRIMMED_STRING.describe('向用户展示的问题文本'),
    options: z
      .array(z.string())
      .max(12)
      .optional()
      .describe('单个问题的可选预设按钮；不要放多个问题或多个维度。多问题必须使用 ask_user_questions。'),
    placeholder: z
      .string()
      .max(200)
      .optional()
      .describe('自由输入框的 placeholder 文案'),
  }),
  skill_compact_context: z.object({}),
  skill_run_shell: z.object({
    command: TRIMMED_STRING.describe(
      '要在技能沙箱内执行的命令。cwd 为技能 managedPath，env 含 CLAUDE_SKILL_DIR 和 CLAUDE_SKILL_OUTPUT_DIR。除基础白名单外，当前技能声明且已获执行同意的 metadata.requires.bins 程序也可直接调用；禁止 rm / cp / mv。脚本优先通过 bash scripts/x.sh 或 python scripts/x.py 调用。',
    ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('毫秒级超时，默认 60000，最大 600000 (10 分钟)'),
    stdin: z
      .string()
      .max(64_000)
      .optional()
      .describe('写入子进程标准输入的字符串（可选）'),
  }),
  skill_write_artifact: z.object({
    relativePath: TRIMMED_STRING.describe(
      '【必填·字符串】相对 artifact 根目录的路径，如 "报告.md" 或 "子目录/报告.md"；也接受 artifact 根目录内、由工具结果返回的绝对路径。禁止根外绝对路径、~/、..、SKILL.md / ready-skill.json / skill.workflow.json 等保留文件。要落到用户目录请先写此路径、再用 skill_export_artifact 导出。',
    ),
    content: z.string().describe('【必填·字符串】要写入文件的完整正文；缺省或传非字符串会以 invalid_type 被拒。utf-8 默认；二进制请 base64 编码并设置 encoding。'),
    encoding: z
      .enum(['utf-8', 'base64'])
      .optional()
      .describe('默认 utf-8；base64 用于二进制内容'),
    mode: z
      .enum(['overwrite', 'append'])
      .optional()
      .describe('默认 overwrite 覆盖写入；长文档需要补齐尾部章节时用 append 追加到同一路径'),
  }),
  skill_read_artifact: z.object({
    relativePath: TRIMMED_STRING.describe('相对 artifact 根目录、当前任务读根或 skill 托管资源目录的路径；也接受这些根目录内、由工具结果返回的绝对路径'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(1_048_576)
      .optional()
      .describe('最多读取字节数，默认 32768（32K），最大 1048576（1M）'),
  }),
  skill_export_artifact: z.object({
    relativePath: TRIMMED_STRING.describe('相对 artifact 根目录的源文件路径，必须指向已有 skill 产物'),
    targetPath: TRIMMED_STRING.describe('要导出到的用户目标文件绝对路径'),
    overwrite: z.boolean().optional().describe('目标已存在时是否覆盖，默认 false'),
  }),
  skill_patch_config: z.object({
    target: TRIMMED_STRING.describe('manifest host_requirements.config_repair.files 中声明的 id、basename 或完整路径。'),
    operations: z
      .array(z.object({
        op: z.enum(['set', 'delete']).describe('set 写入 JSON pointer；delete 删除 JSON pointer。'),
        path: TRIMMED_STRING.describe('JSON pointer，例如 /auto_scoring/fallback_models。'),
        value: z.unknown().optional().describe('set 操作的新值；delete 操作忽略。'),
      }))
      .min(1)
      .max(50)
      .describe('要原子应用到目标 JSON 文件的一组补丁操作。'),
  }),
  skill_start_detached: z.object({
    action: TRIMMED_STRING.describe('要后台启动的当前 skill typed action 名称。'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('传给 typed action 的参数。'),
  }),
  skill_inspect_detached: z.object({
    taskId: TRIMMED_STRING.describe('skill_start_detached 返回的后台任务 id。'),
  }),
  skill_cancel_detached: z.object({
    taskId: TRIMMED_STRING.describe('skill_start_detached 返回的后台任务 id。'),
  }),
  // Phase 5.1 — generic run_state inspector. The audit found that long
  // multi-step skills (VEA pipeline et al.) write a `run_state.json` in
  // their output dir to track which step is in flight, what file they're
  // waiting on, and the last error. Without a primitive, the model could
  // only read the file via skill_read_artifact and parse JSON blindly,
  // which routinely went wrong. This primitive parses the canonical
  // shape, extracts well-known keys, and returns a bounded raw slice.
  skill_inspect_run_state: z.object({
    outputDir: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('要检查 run_state.json 所在目录。绝对或相对都可；与 taskId 二选一。'),
    runStatePath: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('显式 run_state.json 路径；用于用户引用了具体 run_state.json 文件时避免退到 read_artifact。'),
    taskId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('detached task id；从该任务的 outputDir 解析 run_state.json，与 outputDir/runStatePath 三选一。'),
    expectedTaskId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('期望匹配的 run_state.json.task_id；用于一个 outputDir 下存在多个任务时避免按最新 mtime 误选。'),
    maxRawBytes: z
      .number()
      .int()
      .positive()
      .max(65_536)
      .optional()
      .describe('原始 JSON 截断上限，默认 16384 (16K)，避免污染 LLM 上下文。'),
  }),
} as const

export type SkillPrimitiveName = keyof typeof SKILL_PRIMITIVE_SCHEMAS
