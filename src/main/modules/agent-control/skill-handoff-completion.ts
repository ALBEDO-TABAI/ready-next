import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import { atomicWriteText } from './atomic-write'
import { markSkillHandoffOutputCompleted, updateSkillHandoffTaskState } from './skill-agent-handoff'

export interface SkillHandoffTask {
  name: string
  taskPath: string
  outputPath: string
  receiptPath: string
  validationErrorsPath?: string | null
}

export interface SkillHandoffCompletionSummary {
  name: string
  taskPath: string
  outputPath: string
  bytesWritten: number
  model: string
  reusedExisting?: boolean
  repairedValidation?: boolean
}

export interface CompletePendingSkillHandoffsOptions {
  outputDir: string
  agentContext: AgentSpawnContext
  fetchImpl?: typeof fetch
}

const HANDOFF_DIR = 'audiovisual_handoff'
const HANDOFF_TIMEOUT_MS = 240_000
const HANDOFF_MAX_ATTEMPTS = 3
const HANDOFF_TIMEOUT_USER_MESSAGE = '报告生成超时，可继续重试'
const inFlightHandoffs = new Map<string, Promise<SkillHandoffCompletionSummary>>()

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return null
  }
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return 0
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..')
}

function resolveTaskPaths(outputDir: string, name: string, rawTask: unknown): SkillHandoffTask | null {
  const task = objectValue(rawTask)
  const taskRel = stringValue(task?.task) || `${HANDOFF_DIR}/${name}/task.md`
  const outputRelRaw = stringValue(task?.output)
  if (!isSafeRelativePath(taskRel) || !isSafeRelativePath(outputRelRaw)) return null
  const outputRel = outputRelRaw.startsWith(`${HANDOFF_DIR}/`)
    ? outputRelRaw
    : `${HANDOFF_DIR}/${outputRelRaw}`
  return {
    name,
    taskPath: join(outputDir, taskRel),
    outputPath: join(outputDir, outputRel),
    receiptPath: join(outputDir, HANDOFF_DIR, 'receipt.json'),
  }
}

export function listPendingSkillHandoffTasks(outputDir: string): SkillHandoffTask[] {
  const receipt = readJson(join(outputDir, HANDOFF_DIR, 'receipt.json'))
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const pending: SkillHandoffTask[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const task = objectValue(rawTask)
    const status = stringValue(task?.status).toLowerCase()
    if (status !== 'pending' && status !== 'pending_retry' && status !== 'in_progress' && status !== 'blocked' && status !== 'completed') continue
    const item = resolveTaskPaths(outputDir, name, rawTask)
    if (!item) continue
    if (status === 'completed' && isReusableExistingHandoffOutput(item)) continue
    pending.push(item)
  }
  return pending
}

export function listHandoffValidationRepairTasks(outputDir: string): SkillHandoffTask[] {
  const receipt = readJson(join(outputDir, HANDOFF_DIR, 'receipt.json'))
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const repairs: SkillHandoffTask[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const item = resolveTaskPaths(outputDir, name, rawTask)
    if (!item) continue
    const validationErrorsPath = join(outputDir, HANDOFF_DIR, name, 'validation_errors.json')
    if (!existsSync(validationErrorsPath) || !existsSync(item.outputPath)) continue
    try {
      if (statSync(validationErrorsPath).mtimeMs <= statSync(item.outputPath).mtimeMs) continue
    } catch {
      continue
    }
    repairs.push({ ...item, validationErrorsPath })
  }
  return repairs
}

function isValidHandoffOutput(outputPath: string, text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (outputPath.toLowerCase().endsWith('.svg')) {
    return /<svg\b[\s\S]*<\/svg>/i.test(trimmed)
  }
  return true
}

function isReusableExistingHandoffOutput(task: SkillHandoffTask): boolean {
  try {
    const stat = statSync(task.outputPath)
    if (!stat.isFile() || stat.size <= 0) return false
    return isValidHandoffOutput(task.outputPath, readFileSync(task.outputPath, 'utf8'))
  } catch {
    return false
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

function extractOpenAIChatText(payload: unknown): string {
  const rec = objectValue(payload)
  const choices = Array.isArray(rec?.choices) ? rec.choices : []
  for (const choice of choices) {
    const message = objectValue(objectValue(choice)?.message)
    const content = message?.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content.map((part) => stringValue(objectValue(part)?.text)).filter(Boolean).join('\n')
      if (text.trim()) return text
    }
  }
  return ''
}

function extractResponsesText(payload: unknown): string {
  const rec = objectValue(payload)
  const direct = stringValue(rec?.output_text)
  if (direct) return direct
  const output = Array.isArray(rec?.output) ? rec.output : []
  const parts: string[] = []
  for (const item of output) {
    const content = Array.isArray(objectValue(item)?.content) ? objectValue(item)?.content as unknown[] : []
    for (const part of content) {
      const text = stringValue(objectValue(part)?.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

function extractAnthropicText(payload: unknown): string {
  const rec = objectValue(payload)
  const content = Array.isArray(rec?.content) ? rec.content : []
  return content.map((part) => stringValue(objectValue(part)?.text)).filter(Boolean).join('\n')
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function requestHandoffCompletion(
  agentContext: AgentSpawnContext,
  task: SkillHandoffTask,
  taskText: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const system = [
    'You are the hosting Ready agent completing a skill handoff task packet.',
    'Read the task packet exactly and return only the requested output file content.',
    'Do not wrap the answer in code fences. Do not add explanations outside the requested artifact.',
  ].join('\n')
  const user = [
    `Pending handoff task: ${task.name}`,
    '',
    taskText,
  ].join('\n')
  const baseUrl = agentContext.base_url.replace(/\/+$/, '')
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${agentContext.api_key}`,
  }
  if (agentContext.api_kind === 'openai-responses') {
    const resp = await fetchWithTimeout(fetchImpl, `${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: agentContext.model_id,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_output_tokens: 16000,
      }),
    })
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
    const text = extractResponsesText(JSON.parse(raw))
    if (!text.trim()) throw new Error('handoff model returned empty output')
    return stripCodeFence(text)
  }
  if (agentContext.api_kind === 'anthropic-messages') {
    const resp = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...headers,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: agentContext.model_id,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 16000,
      }),
    })
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
    const text = extractAnthropicText(JSON.parse(raw))
    if (!text.trim()) throw new Error('handoff model returned empty output')
    return stripCodeFence(text)
  }
  const resp = await fetchWithTimeout(fetchImpl, `${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: agentContext.model_id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 16000,
    }),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
  const text = extractOpenAIChatText(JSON.parse(raw))
  if (!text.trim()) throw new Error('handoff model returned empty output')
  return stripCodeFence(text)
}

async function requestValidHandoffCompletion(
  agentContext: AgentSpawnContext,
  task: SkillHandoffTask,
  taskText: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  let lastOutput = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const prompt = attempt === 1
      ? taskText
      : [
          taskText,
          '',
          '--- Previous invalid output ---',
          lastOutput,
          '',
          'Repair instructions:',
          '- Return the complete requested output file, not a patch.',
          '- If the output is SVG, it must contain one complete <svg>...</svg> document with a closing </svg> tag.',
        ].join('\n')
    const output = await requestHandoffCompletion(agentContext, task, prompt, fetchImpl)
    if (isValidHandoffOutput(task.outputPath, output)) return output
    lastOutput = output
  }
  throw new Error(`handoff ${task.name} returned invalid output`)
}

function markCompleted(task: SkillHandoffTask): void {
  markSkillHandoffOutputCompleted({
    receiptPath: task.receiptPath,
    taskName: task.name,
    outputPath: task.outputPath,
  })
}

function readTaskReceiptRecord(task: SkillHandoffTask): Record<string, unknown> | null {
  const receipt = readJson(task.receiptPath)
  const tasks = objectValue(receipt?.tasks)
  return objectValue(tasks?.[task.name])
}

function readAttemptCount(task: SkillHandoffTask): number {
  return numberValue(readTaskReceiptRecord(task)?.attempt_count)
}

function markInProgress(task: SkillHandoffTask): void {
  updateSkillHandoffTaskState({
    receiptPath: task.receiptPath,
    taskName: task.name,
    status: 'in_progress',
  })
}

function isAbortLikeError(error: unknown): boolean {
  const rec = objectValue(error)
  const name = stringValue(rec?.name)
  const message = error instanceof Error ? error.message : stringValue(rec?.message)
  return name === 'AbortError'
    || message === 'This operation was aborted'
    || message === 'The operation was aborted'
}

function classifyHandoffError(error: unknown): { kind: string, message: string } {
  if (isAbortLikeError(error)) {
    return {
      kind: 'handoff_timeout',
      message: HANDOFF_TIMEOUT_USER_MESSAGE,
    }
  }
  const message = error instanceof Error
    ? error.message
    : stringValue(error) || 'handoff completion failed'
  if (message.startsWith('handoff model failed')) {
    return {
      kind: 'handoff_model_failed',
      message,
    }
  }
  if (message.includes('returned invalid output')) {
    return {
      kind: 'handoff_invalid_output',
      message,
    }
  }
  if (message.includes('returned empty output')) {
    return {
      kind: 'handoff_empty_output',
      message,
    }
  }
  return {
    kind: 'handoff_completion_failed',
    message,
  }
}

function markFailedAttempt(task: SkillHandoffTask, previousAttemptCount: number, error: unknown): Error {
  const detail = classifyHandoffError(error)
  const attemptCount = previousAttemptCount + 1
  updateSkillHandoffTaskState({
    receiptPath: task.receiptPath,
    taskName: task.name,
    status: attemptCount >= HANDOFF_MAX_ATTEMPTS ? 'failed' : 'pending_retry',
    attemptCount,
    lastErrorKind: detail.kind,
    lastErrorMessage: detail.message,
  })
  return new Error(detail.message)
}

function handoffSingleFlightKey(task: SkillHandoffTask): string {
  return `${task.receiptPath}\0${task.name}\0${task.outputPath}`
}

async function completeTaskFromPrompt(
  task: SkillHandoffTask,
  agentContext: AgentSpawnContext,
  fetchImpl: typeof fetch,
  buildPrompt: () => string,
  summaryPatch?: Pick<SkillHandoffCompletionSummary, 'repairedValidation'>,
): Promise<SkillHandoffCompletionSummary> {
  const attemptCount = readAttemptCount(task)
  if (attemptCount >= HANDOFF_MAX_ATTEMPTS) {
    updateSkillHandoffTaskState({
      receiptPath: task.receiptPath,
      taskName: task.name,
      status: 'failed',
      attemptCount,
      lastErrorKind: 'handoff_retry_exhausted',
      lastErrorMessage: 'handoff retry limit reached',
    })
    throw new Error('handoff retry limit reached')
  }
  markInProgress(task)
  try {
    const output = await requestValidHandoffCompletion(
      agentContext,
      task,
      buildPrompt(),
      fetchImpl,
    )
    atomicWriteText(task.outputPath, output)
    markCompleted(task)
    return {
      name: task.name,
      taskPath: task.taskPath,
      outputPath: task.outputPath,
      bytesWritten: Buffer.byteLength(output, 'utf8'),
      model: `${agentContext.provider}/${agentContext.model_id}`,
      ...summaryPatch,
    }
  } catch (error) {
    throw markFailedAttempt(task, attemptCount, error)
  }
}

async function completeTask(
  task: SkillHandoffTask,
  agentContext: AgentSpawnContext,
  fetchImpl: typeof fetch,
): Promise<SkillHandoffCompletionSummary> {
  if (isReusableExistingHandoffOutput(task)) {
    markCompleted(task)
    return {
      name: task.name,
      taskPath: task.taskPath,
      outputPath: task.outputPath,
      bytesWritten: statSync(task.outputPath).size,
      model: 'existing-output',
      reusedExisting: true,
    }
  }
  return completeTaskFromPrompt(
    task,
    agentContext,
    fetchImpl,
    () => readFileSync(task.taskPath, 'utf8'),
  )
}

function completeValidationRepairTask(
  task: SkillHandoffTask,
  agentContext: AgentSpawnContext,
  fetchImpl: typeof fetch,
): Promise<SkillHandoffCompletionSummary> {
  return completeTaskFromPrompt(
    task,
    agentContext,
    fetchImpl,
    () => [
      readFileSync(task.taskPath, 'utf8'),
      '',
      '--- Current output that failed validation ---',
      existsSync(task.outputPath) ? readFileSync(task.outputPath, 'utf8') : '',
      '',
      '--- validation_errors.json ---',
      task.validationErrorsPath ? readFileSync(task.validationErrorsPath, 'utf8') : '',
      '',
      'Repair instructions:',
      '- Return the complete corrected output file, not a patch.',
      '- Preserve useful existing analysis, but satisfy every validation error exactly.',
    ].join('\n'),
    { repairedValidation: true },
  )
}

function runTaskSingleFlight(
  task: SkillHandoffTask,
  runner: () => Promise<SkillHandoffCompletionSummary>,
): Promise<SkillHandoffCompletionSummary> {
  const key = handoffSingleFlightKey(task)
  const existing = inFlightHandoffs.get(key)
  if (existing) return existing
  const pending = runner()
    .finally(() => {
      inFlightHandoffs.delete(key)
    })
  inFlightHandoffs.set(key, pending)
  return pending
}

export async function completePendingSkillHandoffs(
  options: CompletePendingSkillHandoffsOptions,
): Promise<SkillHandoffCompletionSummary[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const completed: SkillHandoffCompletionSummary[] = []
  for (const task of listPendingSkillHandoffTasks(options.outputDir)) {
    completed.push(await runTaskSingleFlight(
      task,
      () => completeTask(task, options.agentContext, fetchImpl),
    ))
  }
  for (const task of listHandoffValidationRepairTasks(options.outputDir)) {
    completed.push(await runTaskSingleFlight(
      task,
      () => completeValidationRepairTask(task, options.agentContext, fetchImpl),
    ))
  }
  return completed
}
