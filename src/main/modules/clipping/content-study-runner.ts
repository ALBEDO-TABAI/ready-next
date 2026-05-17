/**
 * Pure runner for the drag-tab-to-FileTree "内容学习" action.
 *
 * Orchestrates two phases:
 *   1. Web clip — reuses `runClipDraggedTabBackground`. Emits to `clip:back-
 *      groundUpdate` as usual so the existing pendingClips placeholder UX in
 *      the renderer keeps working.
 *   2. Study notes synthesis — feeds the clipped markdown as user message
 *      with study-notes SKILL.md as system prompt to a provider-agnostic
 *      one-shot LLM call (`requestHeadlessOneShot`). Writes the result to
 *      `<targetDir>/<sanitizedTitle>-学习笔记.md`. Emits to a separate
 *      `clip:contentStudyUpdate` channel so the renderer can drive an
 *      independent placeholder row.
 *
 * Failure traps:
 *   - clip phase fails → study placeholder is set to 'skipped' immediately;
 *     no LLM call is started
 *   - AI config absent → study placeholder fails with errorKind:'no_ai_config'
 *   - LLM error → study placeholder fails with errorKind:'ai_failed'
 *   - write conflict → fallback suffix `-2 / -3 / ...` up to 50
 *
 * Lives outside `browser-engine/` to stay testable from host Node, mirroring
 * `clip-dragged-tab-runner.ts`. The IPC layer injects electron-dependent
 * deps (fs, AI config repository read).
 */

import type { AIModelConfig } from '../../../shared/ai-providers'
import {
  type ClipBackgroundUpdate,
  type ClipDraggedTabIPCController,
  type ClipDraggedTabRunnerDeps,
  runClipDraggedTabBackground,
} from './clip-dragged-tab-runner'
import {
  type HeadlessOneShotResult,
  requestHeadlessOneShot,
} from '../content-study/headless-one-shot'

export interface ContentStudyArgs {
  url: string
  title?: string
  target_hint?: string
  target_dir?: string
  /** Optional client-side correlation id for the clip phase. */
  client_task_id_clip?: string
  /** Optional client-side correlation id for the study phase. */
  client_task_id_study?: string
}

export interface ContentStudyAck {
  ok: boolean
  clipTaskId?: string
  studyTaskId?: string
  errorKind?: 'invalid_url' | 'invalid_args'
  errorDetail?: { message: string }
}

export type ContentStudyStatus =
  | 'waiting_for_clip'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export type ContentStudyErrorKind =
  | 'clip_failed'
  /** clip reached status==='completed' but its materialize-to-target-dir step
   * failed (`copyError` set). The clip body still exists in the sandbox, but
   * the user's chosen folder did not get the clip file — so writing study
   * notes "alongside" the clip in the sandbox would be misleading. We surface
   * this as an explicit terminal state instead of silently writing to a
   * folder the user never sees. */
  | 'clip_target_dir_failed'
  | 'no_ai_config'
  | 'skill_md_missing'
  | 'clip_output_unreadable'
  | 'ai_failed'
  | 'write_failed'
  | 'user_too_large'
  | 'unexpected'

export interface ContentStudyBackgroundUpdate {
  kind: 'study'
  taskId: string
  status: ContentStudyStatus
  url: string
  title?: string
  targetHint?: string
  /** Final markdown path of the study notes file once status=='completed'. */
  copiedPath?: string
  errorMessage?: string
  errorKind?: ContentStudyErrorKind
}

export interface ContentStudyRunnerDeps {
  /** Inject so tests can replace with a fast stub. */
  runClipBackground: typeof runClipDraggedTabBackground
  /** Deps to pass into the clip runner — same shape the IPC layer already builds. */
  clipRunnerDeps: ClipDraggedTabRunnerDeps
  /** Read the study-notes SKILL.md from the embedded-skills root. */
  readSkillMd: () => Promise<string>
  /** Read a markdown file (clip output). */
  readMarkdown: (path: string) => Promise<string>
  /** Write the study notes markdown. */
  writeMarkdown: (path: string, content: string) => Promise<void>
  /** Check whether a path already exists (for conflict-aware filename). */
  pathExists: (path: string) => Promise<boolean>
  /** Join path segments. */
  joinPath: (...parts: string[]) => string
  /** Resolve directory of a markdown file. */
  dirnameOf: (path: string) => string
  /** Load active AI config (null when user has not configured one). */
  getActiveAIConfig: () => AIModelConfig | null
  /** Provider-agnostic one-shot LLM call. */
  requestHeadlessOneShot: typeof requestHeadlessOneShot
  /** Inject for test stability. */
  generateTaskId: () => string
}

const HTTP_RE = /^https?:\/\//i

export function validateContentStudyArgs(raw: unknown): ContentStudyAck {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorKind: 'invalid_args', errorDetail: { message: 'args must be an object' } }
  }
  const args = raw as ContentStudyArgs
  if (typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errorKind: 'invalid_args', errorDetail: { message: 'url is required' } }
  }
  if (!HTTP_RE.test(args.url)) {
    return { ok: false, errorKind: 'invalid_url', errorDetail: { message: 'contentStudy only accepts http(s) URLs' } }
  }
  return { ok: true }
}

export function sanitizeStudyFilename(rawTitle: string, urlFallback: string): string {
  const source = (rawTitle || urlFallback || 'untitled').trim()
  const replaced = source
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const truncated = replaced.length > 80 ? replaced.slice(0, 80).trim() : replaced
  return truncated || 'untitled'
}

async function chooseAvailablePath(
  dir: string,
  baseName: string,
  deps: Pick<ContentStudyRunnerDeps, 'pathExists' | 'joinPath'>,
): Promise<string> {
  const initial = deps.joinPath(dir, `${baseName}.md`)
  if (!(await deps.pathExists(initial))) return initial
  for (let i = 2; i <= 50; i += 1) {
    const candidate = deps.joinPath(dir, `${baseName}-${i}.md`)
    if (!(await deps.pathExists(candidate))) return candidate
  }
  return deps.joinPath(dir, `${baseName}-${Date.now()}.md`)
}

export async function runContentStudyBackground(
  clipTaskId: string,
  studyTaskId: string,
  args: ContentStudyArgs,
  controller: ClipDraggedTabIPCController,
  deps: ContentStudyRunnerDeps,
): Promise<void> {
  const base = {
    kind: 'study' as const,
    taskId: studyTaskId,
    url: args.url,
    title: args.title,
    targetHint: args.target_hint,
  }
  emitStudy(controller, { ...base, status: 'waiting_for_clip' })

  // Spy on clip events so we know when phase 1 finishes.
  // Wrap in an object so TypeScript control flow tracks mutation through the
  // controller closure (a `let` would narrow to `null` after the null check).
  const capture: { final: ClipBackgroundUpdate | null } = { final: null }
  const spyController: ClipDraggedTabIPCController = {
    sendToRenderer: (channel: string, data: unknown) => {
      controller.sendToRenderer(channel, data)
      if (channel !== 'clip:backgroundUpdate') return
      const evt = data as ClipBackgroundUpdate
      if (!evt || evt.taskId !== clipTaskId) return
      if (evt.status === 'completed' || evt.status === 'failed') {
        capture.final = evt
      }
    },
  }

  try {
    await deps.runClipBackground(
      clipTaskId,
      {
        url: args.url,
        title: args.title,
        target_hint: args.target_hint,
        target_dir: args.target_dir,
        client_task_id: clipTaskId,
      },
      spyController,
      deps.clipRunnerDeps,
    )
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'skipped',
      errorKind: 'clip_failed',
      errorMessage: `clip phase threw: ${(err as Error).message}`,
    })
    return
  }

  if (!capture.final) {
    emitStudy(controller, {
      ...base,
      status: 'skipped',
      errorKind: 'clip_failed',
      errorMessage: 'clip phase did not emit a terminal update',
    })
    return
  }
  const clipFinal = capture.final

  if (clipFinal.status === 'failed') {
    emitStudy(controller, {
      ...base,
      status: 'skipped',
      errorKind: 'clip_failed',
      errorMessage: `剪藏未完成（${clipFinal.errorKind}），学习笔记跳过`,
    })
    return
  }
  if (clipFinal.status !== 'completed') {
    // Spy only captures completed/failed terminal updates, so this branch
    // is structurally unreachable. Narrow for TypeScript and emit a defensive
    // skipped event if the invariant ever breaks.
    emitStudy(controller, {
      ...base,
      status: 'skipped',
      errorKind: 'clip_failed',
      errorMessage: `clip phase ended in unexpected state: ${(clipFinal as { status?: string }).status}`,
    })
    return
  }

  // Clip's `completed` status is "soft": it can still carry `copyError`
  // meaning the markdown body is only in the sandbox, NOT in the user's
  // target folder. For content-study, where the user explicitly dropped on
  // a folder, we MUST NOT silently write the study notes back into the
  // sandbox — that would falsely look "successful" while neither file ends
  // up in the folder the user dragged into. Surface the materialize failure
  // as an explicit study failure instead.
  if (args.target_dir && clipFinal.copyError) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'clip_target_dir_failed',
      errorMessage:
        `剪藏未能写入目标目录（${clipFinal.copyError.kind}: ${clipFinal.copyError.message}）` +
        '，学习笔记跳过',
    })
    return
  }

  // Clip succeeded into the user's chosen folder (copiedPath set) OR clip
  // ran without a target_dir (sandbox-only, e.g. agent-invoked). Prefer
  // copiedPath so the study notes land next to the clip file in the user-
  // visible folder; fall back to savedPath only when target_dir was absent.
  const clipMdPath = clipFinal.copiedPath || clipFinal.savedPath
  if (!clipMdPath) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'clip_output_unreadable',
      errorMessage: 'clip completed but reported no output path',
    })
    return
  }

  const config = deps.getActiveAIConfig()
  if (!config) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'no_ai_config',
      errorMessage: '尚未配置 AI 模型，请先在设置中选择默认模型',
    })
    return
  }

  let clipMarkdown: string
  try {
    clipMarkdown = await deps.readMarkdown(clipMdPath)
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'clip_output_unreadable',
      errorMessage: `无法读取剪藏正文：${(err as Error).message}`,
    })
    return
  }

  let skillSystem: string
  try {
    skillSystem = await deps.readSkillMd()
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'skill_md_missing',
      errorMessage: `无法读取 study-notes 方法论文档：${(err as Error).message}`,
    })
    return
  }

  emitStudy(controller, { ...base, status: 'running' })

  const userMessage = buildStudyUserMessage({
    title: args.title,
    url: args.url,
    markdown: clipMarkdown,
  })

  let result: HeadlessOneShotResult
  try {
    result = await deps.requestHeadlessOneShot({
      system: skillSystem,
      user: userMessage,
      config,
    })
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'unexpected',
      errorMessage: `LLM 调用抛出：${(err as Error).message}`,
    })
    return
  }

  if (!result.ok) {
    const errorKind: ContentStudyErrorKind = result.errorKind === 'user_too_large'
      ? 'user_too_large'
      : 'ai_failed'
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind,
      errorMessage: `${result.errorKind}: ${result.message}`,
    })
    return
  }

  // Write the study notes next to the clip output.
  const studyDir = deps.dirnameOf(clipMdPath)
  const baseName = `${sanitizeStudyFilename(args.title || '', args.url)}-学习笔记`
  let studyPath: string
  try {
    studyPath = await chooseAvailablePath(studyDir, baseName, deps)
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'write_failed',
      errorMessage: `选择写入路径失败：${(err as Error).message}`,
    })
    return
  }
  try {
    await deps.writeMarkdown(studyPath, result.text)
  } catch (err) {
    emitStudy(controller, {
      ...base,
      status: 'failed',
      errorKind: 'write_failed',
      errorMessage: `写入学习笔记失败：${(err as Error).message}`,
    })
    return
  }

  emitStudy(controller, {
    ...base,
    status: 'completed',
    copiedPath: studyPath,
  })
}

function buildStudyUserMessage(input: { title?: string; url: string; markdown: string }): string {
  const titleLine = input.title ? `标题：${input.title}\n` : ''
  const urlLine = `来源：${input.url}\n`
  return [
    '请基于以下网页正文，按 study-notes 方法论生成结构化学习笔记。',
    '注意：',
    '- 先在 SKILL.md 的内容类型路由表里选定一种类型并执行其方法',
    '- 输出本身用 Markdown 表达，但不要外加 ```markdown 包装',
    '- 如果材料明显不适合做笔记（纯表格 / 纯代码 / 法律条款 / 说明书），按 unsuitable-input 处理',
    '',
    titleLine + urlLine,
    '正文：',
    '',
    input.markdown,
  ].join('\n')
}

function emitStudy(controller: ClipDraggedTabIPCController, update: ContentStudyBackgroundUpdate): void {
  controller.sendToRenderer('clip:contentStudyUpdate', update)
}
