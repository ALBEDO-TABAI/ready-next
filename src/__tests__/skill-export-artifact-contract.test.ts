import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PRIMITIVE_TOOL_NAMES, SKILL_PRIMITIVE_SCHEMAS, executeExportArtifact } from '../main/modules/tools/skill-primitives'
import { collectToolOutputProofs } from '../main/modules/agent-control/quality/proof-collector'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ready-skill-export-'))
}

test('skill_export_artifact is exposed as a primitive with schema', () => {
  assert.ok(PRIMITIVE_TOOL_NAMES.includes('skill_export_artifact'))
  assert.ok(SKILL_PRIMITIVE_SCHEMAS.skill_export_artifact)
})

test('skill_export_artifact copies an existing artifact to the requested target path', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    const targetPath = join(root, 'delivery', '方案.md')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, '方案.md'), 'hello', 'utf-8')

    const output = await executeExportArtifact({ relativePath: '方案.md', targetPath }, {
      skillId: 'demo-skill',
      lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
      allowedExportRoots: [root],
    })

    const exportedPath = (output.data as Record<string, unknown>).absolutePath as string
    assert.equal(readFileSync(targetPath, 'utf-8'), 'hello')
    assert.equal(readFileSync(exportedPath, 'utf-8'), 'hello')
    assert.match(output.text, /Exported/)
    assert.ok(exportedPath.endsWith('/delivery/方案.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_export_artifact refuses path escape from artifact root', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    await assert.rejects(
      () => executeExportArtifact({ relativePath: '../secret.md', targetPath: join(root, 'out.md') }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /escapes sandbox root|path_escape/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('skill_export_artifact refuses export when target is outside authorized roots', async () => {
  const root = tmpRoot()
  const otherRoot = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, '方案.md'), 'hello', 'utf-8')

    await assert.rejects(
      () => executeExportArtifact({ relativePath: '方案.md', targetPath: join(otherRoot, '方案.md') }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /targetPath must be inside an authorized workspace root|target_outside_workspace/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(otherRoot, { recursive: true, force: true })
  }
})


test('skill_export_artifact refuses default overwrite and symlink overwrite', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    const targetPath = join(root, 'delivery', '方案.md')
    mkdirSync(artifactRoot, { recursive: true })
    mkdirSync(join(root, 'delivery'), { recursive: true })
    writeFileSync(join(artifactRoot, '方案.md'), 'hello', 'utf-8')
    writeFileSync(targetPath, 'existing', 'utf-8')

    await assert.rejects(
      () => executeExportArtifact({ relativePath: '方案.md', targetPath }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /targetPath already exists|target_exists/,
    )

    await executeExportArtifact({ relativePath: '方案.md', targetPath, overwrite: true }, {
      skillId: 'demo-skill',
      lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
      allowedExportRoots: [root],
    })
    assert.equal(readFileSync(targetPath, 'utf-8'), 'hello')

    const linkPath = join(root, 'delivery', 'linked.md')
    symlinkSync(targetPath, linkPath)
    await assert.rejects(
      () => executeExportArtifact({ relativePath: '方案.md', targetPath: linkPath, overwrite: true }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /Refusing to overwrite symlink|symlink_rejected/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_export_artifact refuses target parent symlink escape', async () => {
  const root = tmpRoot()
  const otherRoot = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    const linkDir = join(root, 'linked-delivery')
    mkdirSync(artifactRoot, { recursive: true })
    mkdirSync(otherRoot, { recursive: true })
    writeFileSync(join(artifactRoot, '方案.md'), 'hello', 'utf-8')
    symlinkSync(otherRoot, linkDir)

    await assert.rejects(
      () => executeExportArtifact({ relativePath: '方案.md', targetPath: join(linkDir, '方案.md') }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /targetPath parent must resolve inside an authorized workspace root|target_outside_workspace/,
    )

    await assert.rejects(
      () => executeExportArtifact({ relativePath: '方案.md', targetPath: join(linkDir, 'nested', '方案.md') }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /targetPath parent must resolve inside an authorized workspace root|target_outside_workspace/,
    )
    assert.equal(existsSync(join(otherRoot, 'nested')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(otherRoot, { recursive: true, force: true })
  }
})

test('skill_export_artifact refuses symlink source artifacts', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    mkdirSync(artifactRoot, { recursive: true })
    const realFile = join(artifactRoot, 'real.md')
    writeFileSync(realFile, 'hello', 'utf-8')
    symlinkSync(realFile, join(artifactRoot, 'linked.md'))

    await assert.rejects(
      () => executeExportArtifact({ relativePath: 'linked.md', targetPath: join(root, 'delivery', 'linked.md') }, {
        skillId: 'demo-skill',
        lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [root],
      }),
      /Refusing to export symlink artifact|symlink_rejected/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_export_artifact output mints artifact proof for exported target', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    const targetPath = join(root, 'delivery', '方案.md')
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(join(artifactRoot, '方案.md'), 'hello', 'utf-8')

    const output = await executeExportArtifact({ relativePath: '方案.md', targetPath }, {
      skillId: 'demo-skill',
      lookupSkillRoots: () => ({ skillId: 'demo-skill', assetRoot: join(root, 'asset'), artifactRoot }),
      allowedExportRoots: [root],
    })
    const exportedPath = (output.data as Record<string, unknown>).absolutePath as string
    const proofs = collectToolOutputProofs('skill_export_artifact', output, new Date('2026-06-24T00:00:00.000Z'))
    assert.ok(proofs.some((proof) => proof.kind === 'artifact' && proof.ref === exportedPath))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
