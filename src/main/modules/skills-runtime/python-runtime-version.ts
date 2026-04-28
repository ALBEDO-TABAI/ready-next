export interface PythonVersionInfo {
  major: number
  minor: number
  patch?: number
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
