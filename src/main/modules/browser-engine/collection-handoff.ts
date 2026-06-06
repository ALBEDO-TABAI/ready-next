import { homedir } from 'node:os'
import { join } from 'node:path'

import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import type { BrowserCapabilityTaskHandle } from './capability-types'
import type { BrowserCollectionTarget } from './collection-targets'
import { targetsFromTask } from './collection-targets'

export interface BrowserCollectionHandoffPlan {
  strategy: 'card_loop' | 'url_batch'
  notes: BrowserCollectionTarget[]
  plan: Record<string, unknown>
}

function resultObject(task: BrowserCapabilityTaskHandle | null): Record<string, unknown> | null {
  return task?.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
}

function noteTitleKey(note: BrowserCollectionTarget): string {
  return String(note.title || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function buildCollectionPlanNotes(notes: BrowserCollectionTarget[]): Array<Record<string, unknown>> {
  const titleCounts = new Map<string, number>()
  for (const note of notes) {
    const key = noteTitleKey(note)
    if (key) titleCounts.set(key, (titleCounts.get(key) || 0) + 1)
  }
  return notes.map((note, index) => {
    const key = noteTitleKey(note)
    return {
      url: note.openUrl || note.url,
      canonicalUrl: note.canonicalUrl || note.url,
      openUrl: note.openUrl || note.url,
      title: note.title,
      sourceId: note.sourceId,
      titleConfidence: note.titleConfidence,
      order: note.order || index + 1,
      duplicateTitle: key ? (titleCounts.get(key) || 0) > 1 : false,
      kind: note.kind,
    }
  })
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function expandHomePath(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return join(homedir(), 'Documents')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function resolveOutputRootDir(result: Record<string, unknown> | null): string {
  const outputRootDir = stringField(result?.outputRootDir)
  if (outputRootDir) return expandHomePath(outputRootDir)
  const suggestedNextTool = result?.suggestedNextTool && typeof result.suggestedNextTool === 'object'
    ? result.suggestedNextTool as { args?: unknown }
    : null
  const suggestedArgs = suggestedNextTool?.args && typeof suggestedNextTool.args === 'object'
    ? suggestedNextTool.args as Record<string, unknown>
    : null
  const suggestedOutputRootDir = stringField(suggestedArgs?.output_root_dir)
  if (suggestedOutputRootDir) return expandHomePath(suggestedOutputRootDir)
  return join(homedir(), 'Documents', 'Ready采集', 'profile')
}

export function buildCollectionHandoffPlanFromTask(
  sourceTask: BrowserCapabilityTaskHandle | null,
): BrowserCollectionHandoffPlan | null {
  if (!sourceTask || sourceTask.kind !== 'visible_collect' || sourceTask.status !== 'completed') return null
  const notes = targetsFromTask(sourceTask)
  if (notes.length === 0) return null
  const result = resultObject(sourceTask)
  const targetProfileUrl = stringField(result?.targetUrl)
  const highControlCollection = isHighControlPlatformText(targetProfileUrl)
    || notes.some((note) => isHighControlPlatformText(note.url))
  const strategy = highControlCollection ? 'card_loop' : 'url_batch'
  const plan = {
    targetProfileUrl,
    strategy,
    notes: buildCollectionPlanNotes(notes),
    expectedCount: notes.length,
    sourceTaskId: sourceTask.taskId,
    outputRootDir: resolveOutputRootDir(result),
  }
  return { strategy, notes, plan }
}
