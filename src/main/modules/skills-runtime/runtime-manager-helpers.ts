// B8-P (2026-07-05) — pure move of runtime-manager.ts top-level constants and
// pure helpers (HEAD lines 142–166, 179–218, 223–243, 463–508). No behavior
// change; the class body imports these back from here.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import type { SkillRunStatus } from './runtime-manager-types'

export const execFileAsync = promisify(execFile)

export const INSTALL_STATE_FILENAME = '.ready-install-state.json'
export const EMBEDDED_SYNC_STATE_FILENAME = '.ready-embedded-sync-state.json'
export const PYTHON_RUNTIME_STATE_FILENAME = '.ready-python-runtime-state.json'
// Marker written into a per-skill overlay venv dir; carries the venvId that ties
// the skill's install-state to this specific venv build (so a rebuilt venv forces
// a dep re-deploy). Its presence is also how the run path detects an overlay venv.
export const CUSTOM_VENV_MARKER = '.ready-custom-venv.json'
// 国内 PyPI 镜像，用于 source 安装时按来源切换 pip index（与压缩包源自动切换一致）。
export const DOMESTIC_PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'
export const MAX_COMMAND_BUFFER = 24 * 1024 * 1024
/**
 * C6 — per-stream in-memory cap before output spills to a `.logs/` artifact
 * under `<runtimeRoot>/outputs/<skillId>/`. Long-running video / audio skills
 * (e.g. ffmpeg progress, scenedetect noise) routinely produce tens of MiB of
 * stderr; buffering it all in the renderer's tool-result envelope blows the
 * IPC payload and historically caused OOM. 1 MiB matches the run-shell
 * primitive's "first 8K + spill" pattern but with a higher in-memory ceiling
 * because direct actions return their result to the LLM only once (vs.
 * repeatedly through chat), so we can afford a bigger inline preview.
 */
export const DIRECT_ACTION_INMEMORY_CAP = 1 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
export const SCHEDULER_INTERVAL_MS = 60_000

export function normalizeSkillRunStatus(value: unknown, ok?: boolean): SkillRunStatus | undefined {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['blocked', 'pending_review', 'awaiting_input'].includes(status)) return 'blocked'
  if (['failed', 'failure', 'error'].includes(status)) return 'error'
  if (['completed', 'success', 'done'].includes(status)) return 'done'
  if (ok === false) return 'error'
  if (ok === true) return 'done'
  return undefined
}

export function mergeSkillRunStatus(
  current: SkillRunStatus | undefined,
  detected: SkillRunStatus,
): SkillRunStatus {
  if (current === 'blocked' || current === 'error') return current
  if (detected === 'blocked' || detected === 'error') return detected
  return current || detected
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

/**
 * B-arch-4 — explicit allowlist of embedded skill ids that have been retired
 * (or are slated to be) and whose stale on-disk artifacts should be cleaned
 * up via the host controller on app launch. Adding an id here is a deliberate
 * "yes please cleanup" signal — without this gate, the orphan sweep would
 * pick up any folder that's not in the current `EMBEDDED_SKILLS` list, which
 * is dangerous if a custom-skill manifest hasn't been re-imported yet.
 *
 * Initially contains `'video-expert-analyzer'` per plan §3.4. The skill is
 * still embedded today, so this is effectively a no-op until/unless we drop
 * it from EMBEDDED_SKILLS.
 */
export const RETIRED_EMBEDDED_SKILL_IDS: ReadonlySet<string> = new Set(['video-expert-analyzer'])

export function hashDirectoryContents(root: string): string {
  const hash = createHash('sha256')
  const visit = (dir: string, relativePrefix = ''): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry)
      const relative = relativePrefix ? `${relativePrefix}/${entry}` : entry
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        hash.update(`dir:${relative}\n`)
        visit(absolute, relative)
        continue
      }
      if (!stat.isFile()) continue
      hash.update(`file:${relative}:${stat.size}\n`)
      hash.update(readFileSync(absolute))
      hash.update('\n')
    }
  }
  visit(root)
  return hash.digest('hex')
}

export function asString(value: unknown): string | null {

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.toLowerCase().trim()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return null
}

export function truncateOutput(content: string, max = 18_000): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n...[truncated ${content.length - max} chars]`
}

export function getInstallStatePath(skillPath: string): string {
  return join(skillPath, INSTALL_STATE_FILENAME)
}

export function requirementsDigest(requirementsPath: string): string {
  if (!existsSync(requirementsPath)) return 'missing'
  const content = readFileSync(requirementsPath, 'utf-8')
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i)
    hash |= 0
  }
  return `${content.length}:${hash}`
}
