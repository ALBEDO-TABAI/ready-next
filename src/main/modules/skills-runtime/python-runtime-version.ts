export interface PythonVersionInfo {
  major: number
  minor: number
  patch?: number
}

export interface OpenSslVersionInfo {
  major: number
  minor: number
  patch: number
}

const MIN_READY_PYTHON_MINOR = 9
const MAX_READY_PYTHON_MINOR = 12

export function parsePythonVersionText(value: string): PythonVersionInfo | null {
  const match = String(value || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : undefined,
  }
}

export function isSupportedReadyPythonVersion(version: PythonVersionInfo | null | undefined): boolean {
  if (!version) return false
  return version.major === 3
    && version.minor >= MIN_READY_PYTHON_MINOR
    && version.minor <= MAX_READY_PYTHON_MINOR
}

export function parseOpenSslVersionText(value: string): OpenSslVersionInfo | null {
  const match = String(value || '').match(/OpenSSL\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function isSupportedReadyPythonSslVersion(value: string | null | undefined): boolean {
  const version = parseOpenSslVersionText(value || '')
  if (!version) return false
  if (version.major > 1) return true
  if (version.major < 1) return false
  if (version.minor > 1) return true
  if (version.minor < 1) return false
  return version.patch >= 1
}

export function buildReadyPythonRuntimeNotFoundMessage(params: { sawSslIncompatibleCandidate?: boolean } = {}): string {
  if (params.sawSslIncompatibleCandidate) {
    return 'Python runtime not found. Please install Python 3.9-3.12 with OpenSSL 1.1.1+ support or set setting key `skills_python_path`.'
  }
  return 'Python runtime not found. Please install Python 3.9-3.12 or set setting key `skills_python_path`.'
}

export function buildReadyPythonCandidates(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = [
    configured,
    env.PYTHON3,
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
    'python3',
    'python',
  ]
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const value of values) {
    const candidate = String(value || '').trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    candidates.push(candidate)
  }
  return candidates
}
