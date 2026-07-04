import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildReadyPythonCandidates,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
} from '../main/modules/skills-runtime/python-runtime-version'
import {
  buildPackagedSkillRuntimeEnv,
  getPackagedSkillPythonPath,
  resolvePackagedSkillRuntimeRoot,
} from '../main/modules/skills-runtime/packaged-runtime'

test('Ready Python version gate accepts only Python 3.9 through 3.12', () => {
  for (const version of ['Python 3.9.18', 'Python 3.10.13', 'Python 3.11.8', 'Python 3.12.2']) {
    assert.equal(isSupportedReadyPythonVersion(parsePythonVersionText(version)), true, version)
  }

  for (const version of ['Python 3.8.18', 'Python 3.13.0', 'Python 3.14.0', 'Python 2.7.18', 'not python']) {
    assert.equal(isSupportedReadyPythonVersion(parsePythonVersionText(version)), false, version)
  }
})

test('Ready Python candidates prefer configured and PYTHON3 before supported minor fallbacks', () => {
  assert.deepEqual(
    buildReadyPythonCandidates('/custom/python', { PYTHON3: '/env/python3' }),
    [
      '/custom/python',
      '/env/python3',
      'python3.12',
      'python3.11',
      'python3.10',
      'python3.9',
      'python3',
      'python',
    ],
  )

  assert.deepEqual(
    buildReadyPythonCandidates('python3.12', { PYTHON3: 'python3.12' }),
    ['python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python'],
  )
})

test('skill runtime rebuild contract is pinned to stale venv state identity', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: stale venv rebuild and venvId binding live inside private runtime-manager branches
  const source = readFileSync(new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url), 'utf8')
  // B8-D M2 — the rebuild branch (rmSync + runtime-state identity file) moved
  // verbatim into the delegated PythonRuntimeProvisioner; the venvId
  // install-state binding stays in runtime-manager's installSkillInternal.
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: rebuild body followed the python-runtime cluster split (B8-D M2)
  const provisioner = readFileSync(new URL('../main/modules/skills-runtime/python-runtime-provisioner.ts', import.meta.url), 'utf8')

  assert.match(provisioner, /rmSync\(this\.deps\.venvRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/)
  assert.match(provisioner, /PYTHON_RUNTIME_STATE_FILENAME/)
  assert.match(source, /venvId\?: string/)
  assert.match(source, /state\.venvId\s*&&\s*state\.venvId === venvState\?\.venvId/)
})

test('agent sidecar is pinned to the shared Python version gate', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: sidecar private resolver must stay wired to the shared gate used by skill runtime
  const source = readFileSync(new URL('../main/modules/agent-control/sidecar-manager.ts', import.meta.url), 'utf8')

  assert.match(source, /buildReadyPythonCandidates/)
  assert.match(source, /isSupportedReadyPythonVersion/)
  assert.match(source, /isSupportedReadyPythonSslVersion/)
  assert.match(source, /SIDECAR_REQUIRED_IMPORTS/)
  assert.match(source, /hasRequiredPythonModules\(venvPython\)/)
  assert.match(source, /Sidecar exited before health check/)
  assert.match(source, /No usable Python 3\.9-3\.12 interpreter found/)
  assert.doesNotMatch(source, /minor > 14/)
})

test('packaged skill runtime resolves only when a manifest is present', (t) => {
  const root = join(tmpdir(), `ready-packaged-runtime-${Date.now()}`)
  const resources = join(root, 'Resources')
  const runtimeRoot = join(resources, 'skill-runtime')
  mkdirSync(join(runtimeRoot, 'python', 'bin'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(resolvePackagedSkillRuntimeRoot(resources), null)

  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), '{"runtimeId":"test"}\n', 'utf-8')
  assert.equal(resolvePackagedSkillRuntimeRoot(resources), runtimeRoot)
  assert.equal(getPackagedSkillPythonPath(runtimeRoot, 'darwin').endsWith(join('python', 'bin', 'python3')), true)
  assert.equal(getPackagedSkillPythonPath(runtimeRoot, 'win32').endsWith(join('python', 'Scripts', 'python.exe')), true)
})

test('packaged skill runtime env strips host Python state and stays offline', () => {
  const runtimeRoot = join(tmpdir(), 'ready-packaged-runtime-env')
  const env = buildPackagedSkillRuntimeEnv(runtimeRoot, {
    PATH: '/usr/bin',
    PYTHONHOME: '/host/python',
    PYTHONPATH: '/host/packages',
    PYTHONUSERBASE: '/host/userbase',
    VIRTUAL_ENV: '/host/venv',
    CONDA_DEFAULT_ENV: 'base',
    CONDA_PREFIX: '/host/conda',
  })

  assert.equal(env.PYTHONHOME, undefined)
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.PYTHONUSERBASE, undefined)
  assert.equal(env.VIRTUAL_ENV, undefined)
  assert.equal(env.CONDA_DEFAULT_ENV, undefined)
  assert.equal(env.CONDA_PREFIX, undefined)
  assert.equal(env.PATH?.startsWith(join(runtimeRoot, 'bin')), true)
  assert.equal(env.PIP_NO_INDEX, '1')
  assert.equal(env.PYTHONNOUSERSITE, '1')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.equal(env.MODELSCOPE_OFFLINE, '1')
  assert.equal(env.HF_HUB_OFFLINE, '1')
  assert.equal(env.TRANSFORMERS_OFFLINE, '1')
})

test('release packaging is pinned to a shared offline skill runtime', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- release packaging contract: clean packer must fail closed unless a shared runtime is supplied
  const packer = readFileSync(new URL('../../Packer/pack-clean-release.mjs', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- runtime-manager private install branch must skip pip for covered embedded skills when packaged runtime exists
  const runtimeManager = readFileSync(new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- python-runtime bodies moved to the delegated provisioner (B8-D M2); packaged-env pins follow the bodies
  const pythonProvisioner = readFileSync(new URL('../main/modules/skills-runtime/python-runtime-provisioner.ts', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- shared packaged-runtime helper owns runtime env isolation for skills and sidecar
  const packagedRuntime = readFileSync(new URL('../main/modules/skills-runtime/packaged-runtime.ts', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- sidecar private branch must share the same packaged Python runtime
  const sidecarManager = readFileSync(new URL('../main/modules/agent-control/sidecar-manager.ts', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- skill_run_shell dispatcher must keep custom skills on their user-data runtime when packaged runtime exists
  const skillsTools = readFileSync(new URL('../main/modules/tools/skills-tools.ts', import.meta.url), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- skill_run_shell must accept the full packaged runtime env, not just PATH fragments
  const runShell = readFileSync(new URL('../main/modules/tools/skill-primitives/run-shell.ts', import.meta.url), 'utf8')

  assert.match(packer, /READY_RELEASE_SKILL_RUNTIME_ROOT is required/)
  assert.match(packer, /REQUIRED_RUNTIME_SKILLS/)
  assert.match(packer, /REQUIRED_RUNTIME_MODULES/)
  for (const skillId of [
    'video-expert-analyzer',
    'video-copy-analyzer',
    'lets-go-rss',
    'deep-research',
    'systematic-literature-review',
    'github-deep-research',
    'academic-paper-review',
    'web-design-guidelines',
    'find-skills',
    'obsidian-web-clip',
    'study-notes',
    'image-analysis-router',
    'image-reverse-descriptor',
    'context-compact',
    'fastnote',
  ]) {
    assert.match(packer, new RegExp(`'${skillId}'`), `release runtime must cover ${skillId}`)
  }
  for (const moduleName of [
    'anthropic',
    'apscheduler',
    'browser_cookie3',
    'cv2',
    'dateutil',
    'dotenv',
    'fastapi',
    'ffmpeg',
    'funasr',
    'huggingface_hub',
    'humanfriendly',
    'httpx',
    'lark_oapi',
    'modelscope',
    'numpy',
    'openai',
    'PIL',
    'pydantic',
    'pysrt',
    'reportlab',
    'requests',
    'scenedetect',
    'torch',
    'torchaudio',
    'transformers',
    'tiktoken',
    'safetensors',
    'tokenizers',
    'uvicorn',
    'yt_dlp',
    'rapidocr_onnxruntime',
  ]) {
    assert.match(packer, new RegExp(`'${moduleName}'`), `release runtime must verify ${moduleName}`)
  }
  assert.match(packer, /cache\$\{sep\}whisper/)
  assert.match(packer, /for \(const tool of REQUIRED_RUNTIME_TOOLS\)/)
  assert.match(packer, /verifyPythonRuntimeGate/)
  assert.match(packer, /verifyAsrModelCaches/)
  assert.match(packer, /verifyRuntimeTool/)
  assert.match(packer, /versionArgs = tool === 'ffmpeg' \|\| tool === 'ffprobe' \? \['-version'\] : \['--version'\]/)
  assert.match(packer, /spawnSync\(candidate,\s*versionArgs/)
  assert.match(packer, /verifyRuntimeSource\(cleanPackagedRuntimeRoot\)/)
  assert.match(packer, /rewriteRuntimePythonShebangs\(cleanPackagedRuntimeRoot\)/)
  assert.match(packer, /assertRuntimePythonShebangsAreRelocatable\(cleanPackagedRuntimeRoot\)/)
  assert.match(packer, /#!\/usr\/bin\/env python3/)
  assert.match(packer, /PYTHONNOUSERSITE:\s*'1'/)
  assert.match(packer, /MODELSCOPE_OFFLINE:\s*'1'/)
  assert.match(packer, /FunAudioLLM\/Fun-ASR-Nano-2512/)
  // 兜底 ASR + 标点权重改为按需下载：staged 树剔除并断言缺席，证明安装包瘦身。
  assert.match(packer, /verifyNoBundledModelWeights/)
  assert.match(packer, /STAGED_FORBIDDEN_BUNDLED_WEIGHTS/)
  assert.match(packer, /speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/)
  assert.match(packer, /punc_ct-transformer_cn-en-common-vocab471067-large/)
  assert.match(runtimeManager, /assertPackagedRuntimeCoversEmbeddedSkill/)
  assert.match(runtimeManager, /ensurePythonVenv\(\{ allowPackaged: false \}\)/)
  assert.match(runtimeManager, /installRequirements\(venvPython, requirementsPath, \{ allowPackaged: false \}\)/)
  assert.match(runtimeManager, /ensureRuntimeToolchain\(\{ allowPackaged: false \}\)/)
  assert.match(pythonProvisioner, /getBaseEnv\(\{ allowPackaged \}\)/)
  assert.match(runtimeManager, /getRuntimeEnv\(options: \{ allowPackaged\?: boolean \} = \{\}\)/)
  assert.match(runtimeManager, /getPackagedSkillRuntimeToolCandidates/)
  assert.match(pythonProvisioner, /buildPackagedSkillRuntimeEnv/)
  assert.match(pythonProvisioner, /const runtimeEnv = this\.getBaseEnv\(\{ allowPackaged: true \}\)/)
  assert.match(pythonProvisioner, /getPythonVersion\(pythonPath, runtimeEnv\)/)
  assert.match(pythonProvisioner, /getPythonSslVersionText\(pythonPath, runtimeEnv\)/)
  assert.match(packagedRuntime, /PIP_NO_INDEX:\s*'1'/)
  assert.match(packagedRuntime, /PYTHONNOUSERSITE:\s*'1'/)
  assert.match(packagedRuntime, /HF_HUB_OFFLINE:\s*'1'/)
  assert.match(packagedRuntime, /READY_PACKAGED_SKILL_RUNTIME_ROOT/)
  assert.match(sidecarManager, /resolvePackagedPythonPath/)
  assert.match(sidecarManager, /buildPackagedSkillRuntimeEnv/)
  assert.match(sidecarManager, /getPythonVersion\(pythonPath, runtimeEnv\)/)
  assert.match(sidecarManager, /getPythonSslVersionText\(pythonPath, runtimeEnv\)/)
  assert.match(skillsTools, /const allowPackagedRuntime = skillDef\?\.source === 'embedded'/)
  assert.match(skillsTools, /baseEnv: getManager\(\)\.getRuntimeEnv\(\{ allowPackaged: allowPackagedRuntime \}\)/)
  assert.match(skillsTools, /getRuntimeBinDir\(\{ allowPackaged: allowPackagedRuntime \}\)/)
  assert.match(skillsTools, /getSharedVenvBinDir\(\{ allowPackaged: allowPackagedRuntime \}\)/)
  assert.match(runShell, /baseEnv\?: NodeJS\.ProcessEnv/)
  assert.match(runShell, /buildEnv\(deps\.baseEnv \?\? process\.env/)
})
