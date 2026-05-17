/**
 * `browser:contentStudyDraggedTab` — host-IPC-only fire-and-forget channel
 * for the "内容学习" action in the FileTree drop popup.
 *
 * The renderer drags a browser tab onto FileTree and picks "内容学习" from
 * the drop popup. We:
 *   1. Acknowledge immediately with `{ clipTaskId, studyTaskId }` so the
 *      renderer can put up two placeholders right away.
 *   2. In the background, run the clip phase (re-using existing
 *      `runClipDraggedTabBackground`) which streams progress through the
 *      existing `clip:backgroundUpdate` channel.
 *   3. When clip succeeds, feed the markdown body + study-notes SKILL.md to
 *      `requestHeadlessOneShot`, write the result to `<targetDir>/
 *      <title>-学习笔记.md`, and stream the study-side progress through a
 *      new `clip:contentStudyUpdate` channel.
 *
 * Not model-facing: no entry in any tool registry. The agent loop is
 * unaffected — current chat session does not see this work.
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { buildDefaultDeps } from './ipc-clip-dragged-tab'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { requestHeadlessOneShot } from '../content-study/headless-one-shot'
import {
  runClipDraggedTabBackground,
  type ClipDraggedTabIPCController,
} from '../clipping/clip-dragged-tab-runner'
import {
  type ContentStudyAck,
  type ContentStudyArgs,
  type ContentStudyRunnerDeps,
  runContentStudyBackground,
  validateContentStudyArgs,
} from '../clipping/content-study-runner'

export type {
  ContentStudyAck,
  ContentStudyArgs,
  ContentStudyBackgroundUpdate,
} from '../clipping/content-study-runner'

function buildContentStudyDeps(): ContentStudyRunnerDeps {
  const settingsRepository = new AppSettingsRepository()
  const clipRunnerDeps = buildDefaultDeps()
  return {
    runClipBackground: runClipDraggedTabBackground,
    clipRunnerDeps,
    readSkillMd: async () => {
      const runtime = getSkillsRuntimeManager().getRuntimeInfo()
      const candidatePath = join(runtime.skillsRoot, 'study-notes', 'SKILL.md')
      return readFile(candidatePath, 'utf8')
    },
    readMarkdown: (path: string) => readFile(path, 'utf8'),
    writeMarkdown: async (path: string, content: string) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    },
    pathExists: async (path: string) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    joinPath: (...parts: string[]) => join(...parts),
    dirnameOf: (path: string) => dirname(path),
    getActiveAIConfig: () => settingsRepository.getAIConfig(),
    requestHeadlessOneShot,
    generateTaskId: () => `cs-${Date.now()}-${randomUUID().slice(0, 8)}`,
  }
}

export function setupBrowserContentStudyIPC(
  controller: ClipDraggedTabIPCController,
  deps: ContentStudyRunnerDeps = buildContentStudyDeps(),
): void {
  ipcMain.handle('browser:contentStudyDraggedTab', async (_, raw: unknown): Promise<ContentStudyAck> => {
    const validation = validateContentStudyArgs(raw)
    if (!validation.ok) return validation
    const args = raw as ContentStudyArgs
    const clipTaskId = args.client_task_id_clip || deps.generateTaskId() + '-clip'
    const studyTaskId = args.client_task_id_study || deps.generateTaskId() + '-study'
    void runContentStudyBackground(clipTaskId, studyTaskId, args, controller, deps)
    return { ok: true, clipTaskId, studyTaskId }
  })
}
