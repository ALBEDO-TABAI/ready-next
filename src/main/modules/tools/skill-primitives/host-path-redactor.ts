import { tmpdir } from 'node:os'

/**
 * Stage T (PR-T2 / W7.3) — host-path redactor for shell tool outputs.
 *
 * `skill_run_shell` returns stdout / stderr verbatim to the model and ALSO
 * persists overflow logs under `<artifactRoot>/.logs/shell-<ts>-<uuid>-<stream>.txt`
 * (§6.12). Without redaction those payloads leak the operator's home dir
 * (`/Users/<name>` on macOS, `/home/<name>` on Linux), which is sensitive both
 * for the model context and for any artifact that survives on disk.
 *
 * `redactHostPaths(text)` is invoked **3+ times** inside `run-shell.ts`:
 *   1. before stdout is returned to the model
 *   2. before stderr is returned to the model
 *   3. before the overflow log is written to disk (round-12 fix — without
 *      this the persisted file would still expose `/Users/<name>`)
 *
 * The returned `stdoutArtifactPath` / `stderrArtifactPath` strings are also
 * routed through here because the artifact path itself contains
 * `<artifactRoot>` which usually lives under the user's home dir.
 */

const HOME_VAR = process.env.HOME || ''

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const HOME_PATTERN = HOME_VAR.length > 0 ? new RegExp(escapeRegex(HOME_VAR), 'g') : null
const USERS_PATTERN = /\/Users\/[^/\s]+/g
const LINUX_HOME_PATTERN = /\/home\/[^/\s]+/g
const WINDOWS_USERPROFILE_LITERAL_PATTERN = /%USERPROFILE%/gi
const WINDOWS_USERS_DRIVE_PATTERN = /([A-Z]:)\\Users\\[^\\/\s]+/gi
const WINDOWS_USERS_ROOT_PATTERN = /(^|[\s"'([{:;=,])\\Users\\[^\\/\s]+/gi
const WINDOWS_USERS_DRIVE_ESCAPED_PATTERN = /([A-Z]:)\\\\Users\\\\[^\\/\s]+/gi
const WINDOWS_USERS_ROOT_ESCAPED_PATTERN = /(^|[\s"'([{:;=,])\\\\Users\\\\[^\\/\s]+/gi

function redactLiteralRoot(text: string, root: string, replacement: string): string {
  if (!root) return text
  return text.replace(new RegExp(`${escapeRegex(root)}(?=$|[\\\\/\\s"'\\])},;:])`, 'g'), replacement)
}

function redactStaticRoot(text: string, root: string, replacement: string): string {
  let out = redactLiteralRoot(text, root, replacement)
  if (root.includes('\\')) {
    out = redactLiteralRoot(out, root.replace(/\\/g, '\\\\'), replacement)
  }
  return out
}

function currentResourcesPath(): string {
  const proc = process as NodeJS.Process & { resourcesPath?: unknown }
  return typeof proc.resourcesPath === 'string' ? proc.resourcesPath : ''
}

export function redactHostPaths(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  out = redactStaticRoot(out, tmpdir(), '<tmp>')
  out = redactStaticRoot(out, currentResourcesPath(), '<app>')
  const userProfile = process.env.USERPROFILE || ''
  const escapedUserProfile = userProfile.includes('\\') ? userProfile.replace(/\\/g, '\\\\') : ''
  const escapedUserProfilePattern =
    escapedUserProfile.length > 0 ? new RegExp(escapeRegex(escapedUserProfile), 'gi') : null
  const userProfilePattern = userProfile.length > 0 ? new RegExp(escapeRegex(userProfile), 'gi') : null
  if (escapedUserProfilePattern) {
    out = out.replace(escapedUserProfilePattern, '<userprofile>')
  }
  if (userProfilePattern) {
    out = out.replace(userProfilePattern, '<userprofile>')
  }
  out = out.replace(WINDOWS_USERPROFILE_LITERAL_PATTERN, '<userprofile>')
  if (HOME_PATTERN) {
    out = out.replace(HOME_PATTERN, '~')
  }
  out = out.replace(USERS_PATTERN, '/Users/<redacted>')
  out = out.replace(LINUX_HOME_PATTERN, '/home/<redacted>')
  out = out.replace(WINDOWS_USERS_DRIVE_PATTERN, (_match, drive: string) => `${drive}\\Users\\<redacted>`)
  out = out.replace(WINDOWS_USERS_ROOT_PATTERN, (_match, prefix: string) => `${prefix}\\Users\\<redacted>`)
  out = out.replace(WINDOWS_USERS_DRIVE_ESCAPED_PATTERN, (_match, drive: string) => `${drive}\\\\Users\\\\<redacted>`)
  out = out.replace(WINDOWS_USERS_ROOT_ESCAPED_PATTERN, (_match, prefix: string) => `${prefix}\\\\Users\\\\<redacted>`)
  return out
}
