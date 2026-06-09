import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { SkillsRuntimeManager, type SkillDeploySpawn } from '../main/modules/skills-runtime/runtime-manager'
import type { FetchLike } from '../main/modules/skills-runtime/skill-source-registry'
import type { SkillSource } from '../shared/skill-source-types'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-install-dep-deploy declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-install-dep-deploy transitive sqlite load')
})

const execFileAsync = promisify(execFile)

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// A Python-dependency custom skill: a ready-skill.json declaring a python action +
// requirementsFile, a benign entry script, and a requirements file. The folder
// must pass importCustomSkill's security scan (no shell-exfil patterns).
const READY_SKILL_JSON = JSON.stringify({
  id: 'pyskill',
  name: 'Py Skill',
  runtime: 'python',
  requirementsFile: 'requirements.txt',
  actions: [{ name: 'run', runtime: 'python', entry: 'main.py' }],
})
const PY_LAYOUT: Record<string, string> = {
  'pyskill/ready-skill.json': READY_SKILL_JSON,
  'pyskill/main.py': 'print("hello from pyskill")\n',
  'pyskill/requirements.txt': 'cowsay==6.1\n',
  'pyskill/SKILL.md': ['---', 'name: Py Skill', 'license: MIT', '---', '# Py Skill', 'body'].join('\n'),
}

async function makeTarGz(layout: Record<string, string>, topEntry: string): Promise<Buffer> {
  const work = scratch('ready-dep-src-')
  try {
    for (const [relPath, content] of Object.entries(layout)) {
      const full = join(work, relPath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    const out = join(scratch('ready-dep-out-'), 'archive.tar.gz')
    await execFileAsync('tar', ['-czf', out, '-C', work, topEntry])
    return readFileSync(out)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function serve(buffer: Buffer): FetchLike {
  return async () => new Response(buffer, { headers: { 'content-length': String(buffer.length) } })
}

function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = scratch('ready-dep-rt-')
  const embeddedRoot = scratch('ready-dep-embedded-')
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, embeddedSkillsRoot: embeddedRoot, startBackgroundTasks: false }),
    cleanup: () => {
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(embeddedRoot, { recursive: true, force: true })
    },
  }
}

const TARBALL: SkillSource = { kind: 'tarball', url: 'https://example.com/pyskill.tar.gz' }

interface RecordedCall {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

test('installSkillFromSource deploys Python deps into a bundled-Python overlay venv with online pip', async () => {
  const { manager, cleanup } = makeManager()
  // Prove the online-deploy env DROPS the packaged runtime's offline fences: seed
  // them in the inherited env and assert they are absent on the pip invocation.
  const prevNoIndex = process.env.PIP_NO_INDEX
  const prevHfOffline = process.env.HF_HUB_OFFLINE
  process.env.PIP_NO_INDEX = '1'
  process.env.HF_HUB_OFFLINE = '1'
  try {
    const buffer = await makeTarGz(PY_LAYOUT, 'pyskill')
    const calls: RecordedCall[] = []
    const deploySpawn: SkillDeploySpawn = async (file, args, options) => {
      calls.push({ file, args, env: options.env })
      return { stdout: '', stderr: '' }
    }

    const phases: string[] = []
    const status = await manager.installSkillFromSource(
      { requestId: 'req-py', source: TARBALL, trustAck: true },
      (update) => phases.push(update.phase),
      { fetchImpl: serve(buffer), deploySpawn, deployBasePython: async () => '/fake/python3' },
    )

    assert.equal(status.phase, 'done')
    assert.equal(status.skillId, 'pyskill')
    assert.equal(status.requiresPython, true)
    assert.ok(phases.includes('deploying-deps'), 'the deploy phase must be surfaced')

    const venvCall = calls.find((c) => c.args.includes('venv'))
    assert.ok(venvCall, 'a venv must be built from the resolved base Python')
    assert.equal(venvCall?.file, '/fake/python3')
    assert.ok(venvCall?.args.includes('--system-site-packages'), '--system-site-packages reuses the bundled stack')

    const pipCall = calls.find((c) => c.args.includes('pip'))
    assert.ok(pipCall, 'pip install must run for the requirements file')
    assert.ok(pipCall?.args.includes('install') && pipCall.args.includes('-r'))
    assert.equal(pipCall?.env?.PIP_NO_INDEX, undefined, 'online deploy must drop PIP_NO_INDEX')
    assert.equal(pipCall?.env?.HF_HUB_OFFLINE, undefined, 'online deploy must drop HF_HUB_OFFLINE')

    assert.ok(manager.listSkills().some((s) => s.id === 'pyskill'), 'the skill must be registered after a successful deploy')
  } finally {
    if (prevNoIndex === undefined) delete process.env.PIP_NO_INDEX
    else process.env.PIP_NO_INDEX = prevNoIndex
    if (prevHfOffline === undefined) delete process.env.HF_HUB_OFFLINE
    else process.env.HF_HUB_OFFLINE = prevHfOffline
    cleanup()
  }
})

test('a failed dependency deploy fails loudly and rolls back the half-registered skill', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const buffer = await makeTarGz(PY_LAYOUT, 'pyskill')
    // venv build succeeds; the online pip step fails (e.g. offline / pip error).
    const deploySpawn: SkillDeploySpawn = async (_file, args) => {
      if (args.includes('pip')) throw new Error('Could not fetch URL: network is unreachable')
      return { stdout: '', stderr: '' }
    }

    await assert.rejects(
      () => manager.installSkillFromSource(
        { requestId: 'req-py-fail', source: TARBALL, trustAck: true },
        undefined,
        { fetchImpl: serve(buffer), deploySpawn, deployBasePython: async () => '/fake/python3' },
      ),
      /依赖在线安装失败/,
    )

    assert.equal(
      manager.listSkills().some((s) => s.id === 'pyskill'),
      false,
      'a deps-deploy failure must not leave a half-registered Python skill',
    )
  } finally {
    cleanup()
  }
})
