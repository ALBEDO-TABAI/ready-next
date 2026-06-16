import { normalize, resolve } from 'path'

const SENSITIVE_PATH_PATTERNS = [
  /[/\\]\.ssh[/\\]/,
  /[/\\]\.aws[/\\]/,
  /[/\\]\.gnupg[/\\]/,
  /[/\\]\.env$/,
  /[/\\]credentials$/,
  /[/\\]credentials\.json$/,
  /[/\\]\.npmrc$/,
  /[/\\]\.pypirc$/,
  /[/\\]\.gitconfig$/,
  /[/\\]id_rsa/,
  /[/\\]id_ed25519/,
]

export function isPathAllowed(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false

  const resolved = resolve(filePath)
  const normalized = normalize(resolved)
  const segments = normalized.split(/[/\\]+/)
  if (segments.includes('..')) return false

  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
  const pathToCheck = caseInsensitive ? normalized.toLowerCase() : normalized

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(pathToCheck)) return false
  }

  return true
}
