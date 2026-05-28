import { existsSync, readFileSync } from 'fs'
import { delimiter, join } from 'path'

export const PACKAGED_SKILL_RUNTIME_DIRNAME = 'skill-runtime'
export const PACKAGED_SKILL_RUNTIME_MANIFEST = 'runtime-manifest.json'

export interface PackagedSkillRuntimeManifest {
  runtimeId?: string
  createdAt?: string
  pythonVersion?: string
  pythonSslVersion?: string
  embeddedSkillIds?: string[]
  tools?: string[]
  pythonModules?: string[]
}

export function resolvePackagedSkillRuntimeRoot(resourcesPath?: string | null, override?: string | null): string | null {
  const candidate = override !== undefined
    ? String(override || '').trim()
    : join(String(resourcesPath || ''), PACKAGED_SKILL_RUNTIME_DIRNAME)
  if (!candidate) return null
  if (!existsSync(join(candidate, PACKAGED_SKILL_RUNTIME_MANIFEST))) return null
  return candidate
}

export function readPackagedSkillRuntimeManifest(root: string): PackagedSkillRuntimeManifest | null {
  try {
    return JSON.parse(readFileSync(join(root, PACKAGED_SKILL_RUNTIME_MANIFEST), 'utf-8')) as PackagedSkillRuntimeManifest
  } catch {
    // silent-catch: the manifest file is already existence-gated by resolvePackagedSkillRuntimeRoot, so a throw here means a corrupt/unreadable manifest. All manifest fields are optional metadata hints, so degrade to null ("runtime present, metadata unknown") rather than crashing boot.
    return null
  }
}

export function getPackagedSkillRuntimeBinDir(root: string): string {
  return join(root, 'bin')
}

export function getPackagedSkillRuntimeToolCandidates(
  root: string,
  tool: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  const pythonBinDir = getPackagedSkillPythonBinDir(root, platform)
  return [
    ...suffixes.map((suffix) => join(getPackagedSkillRuntimeBinDir(root), `${tool}${suffix}`)),
    ...suffixes.map((suffix) => join(pythonBinDir, `${tool}${suffix}`)),
  ]
}

export function getPackagedSkillPythonBinDir(root: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? join(root, 'python', 'Scripts')
    : join(root, 'python', 'bin')
}

export function getPackagedSkillPythonPath(root: string, platform: NodeJS.Platform = process.platform): string {
  const binDir = getPackagedSkillPythonBinDir(root, platform)
  return platform === 'win32'
    ? join(binDir, 'python.exe')
    : join(binDir, 'python3')
}

export function getPackagedSkillRuntimeCacheRoot(root: string): string {
  return join(root, 'cache')
}

export function buildPackagedSkillRuntimeEnv(
  root: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of [
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE',
    'VIRTUAL_ENV',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
  ]) {
    delete env[key]
  }

  const cacheRoot = getPackagedSkillRuntimeCacheRoot(root)
  return {
    ...env,
    PATH: [
      getPackagedSkillRuntimeBinDir(root),
      getPackagedSkillPythonBinDir(root),
      env.PATH || '',
    ].join(delimiter),
    XDG_CACHE_HOME: cacheRoot,
    MODELSCOPE_CACHE: join(cacheRoot, 'modelscope'),
    HF_HOME: join(cacheRoot, 'huggingface'),
    READY_PACKAGED_SKILL_RUNTIME_ROOT: root,
    PIP_NO_INDEX: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    MODELSCOPE_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
}
