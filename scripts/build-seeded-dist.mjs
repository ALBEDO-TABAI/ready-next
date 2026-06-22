#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const runtimeRoot = resolve(String(process.env.READY_RELEASE_SKILL_RUNTIME_ROOT || '').trim() || '.')

function fail(message) {
  console.error(`[seeded-dist] ${message}`)
  process.exit(1)
}

function commandForBin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function removeBuildArtifacts() {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const dmgName = `Ready-${packageJson.version}-arm64.dmg`
  rmSync(join(projectRoot, 'exports', 'mac-arm64'), { recursive: true, force: true })
  rmSync(join(projectRoot, 'exports', dmgName), { force: true })
  rmSync(join(projectRoot, 'exports', `${dmgName}.blockmap`), { force: true })
  return {
    appPath: join(projectRoot, 'exports', 'mac-arm64', 'Ready.app'),
    dmgPath: join(projectRoot, 'exports', dmgName),
  }
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: [join(projectRoot, 'node_modules', '.bin'), process.env.PATH || ''].join(delimiter),
    },
    ...options,
  })
  if (result.error) {
    fail(result.error.message)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function createDmgFromVerifiedApp(appPath, dmgPath, stagingRoot) {
  const dmgRoot = join(stagingRoot, 'dmg-root')
  mkdirSync(dmgRoot, { recursive: true })
  run('/usr/bin/ditto', [appPath, join(dmgRoot, 'Ready.app')])
  symlinkSync('/Applications', join(dmgRoot, 'Applications'))
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'Ready',
    '-srcfolder',
    dmgRoot,
    '-ov',
    '-format',
    'UDZO',
    dmgPath,
  ])
}

if (!String(process.env.READY_RELEASE_SKILL_RUNTIME_ROOT || '').trim()) {
  fail('READY_RELEASE_SKILL_RUNTIME_ROOT is required so the seeded DMG includes skill-runtime.')
}
if (!existsSync(runtimeRoot)) {
  fail(`READY_RELEASE_SKILL_RUNTIME_ROOT does not exist: ${runtimeRoot}`)
}

const stagingRoot = mkdtempSync(join(tmpdir(), 'ready-seeded-dist-'))
const tempConfigPath = join(stagingRoot, 'electron-builder.seeded.yml')

try {
  run(process.execPath, [join(projectRoot, 'scripts', 'export-ai-settings-seed.mjs')])
  const artifacts = removeBuildArtifacts()

  const baseConfigPath = join(projectRoot, 'electron-builder.yml')
  const baseConfig = YAML.parse(readFileSync(baseConfigPath, 'utf8'))
  baseConfig.mac = {
    ...(baseConfig.mac || {}),
    target: [
      {
        target: 'dir',
        arch: ['arm64'],
      },
    ],
  }
  baseConfig.extraResources = [
    ...(Array.isArray(baseConfig.extraResources) ? baseConfig.extraResources : []),
    {
      from: runtimeRoot,
      to: 'skill-runtime',
      filter: ['**/*'],
    },
  ]
  writeFileSync(tempConfigPath, YAML.stringify(baseConfig), 'utf8')

  run(commandForBin('npm'), ['run', 'build'])
  run(commandForBin('electron-builder'), ['--config', tempConfigPath])
  run(process.execPath, [join(projectRoot, 'scripts', 'check-packaged-skill-runtime.cjs'), '--app', artifacts.appPath])
  createDmgFromVerifiedApp(artifacts.appPath, artifacts.dmgPath, stagingRoot)
  run('/usr/bin/hdiutil', ['verify', artifacts.dmgPath])
  run(process.execPath, [join(projectRoot, 'scripts', 'check-packaged-skill-runtime.cjs'), '--dmg', artifacts.dmgPath])
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}
