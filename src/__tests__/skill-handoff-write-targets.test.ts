import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeWriteArtifact } from '../main/modules/tools/skill-primitives/write-artifact'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ready-skill-handoff-'))
}

test('skill_write_artifact can write a declared pending handoff output outside the skill artifact root', async () => {
  const root = tempRoot()
  try {
    const handoffDir = join(root, 'audiovisual_handoff')
    mkdirSync(join(handoffDir, 'body'), { recursive: true })
    writeFileSync(join(handoffDir, 'receipt.json'), JSON.stringify({
      tasks: {
        body: {
          status: 'pending',
          task: 'audiovisual_handoff/body/task.md',
          output: 'body/output.md',
        },
      },
    }), 'utf8')
    const artifactRoot = join(root, 'skill-artifacts')
    mkdirSync(artifactRoot, { recursive: true })

    await executeWriteArtifact(
      {
        relativePath: 'audiovisual_handoff/body/output.md',
        content: 'handoff body',
      },
      {
        skillId: 'video-expert-analyzer',
        lookupSkillRoots: () => ({
          skillId: 'video-expert-analyzer',
          assetRoot: root,
          artifactRoot,
        }),
        additionalAllowedWriteTargets: [{
          root,
          relativePath: 'audiovisual_handoff/body/output.md',
          receiptPath: join(handoffDir, 'receipt.json'),
          taskName: 'body',
        }],
      } as any,
    )

    const outputPath = join(handoffDir, 'body', 'output.md')
    assert.equal(existsSync(outputPath), true)
    assert.equal(readFileSync(outputPath, 'utf8'), 'handoff body')
    const receipt = JSON.parse(readFileSync(join(handoffDir, 'receipt.json'), 'utf8'))
    assert.equal(receipt.tasks.body.status, 'completed')
    assert.equal(typeof receipt.tasks.body.updated_at, 'string')
    assert.match(receipt.tasks.body.output_hash, /^[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill_write_artifact rejects non-declared sibling files even when a handoff root is active', async () => {
  const root = tempRoot()
  try {
    const artifactRoot = join(root, 'skill-artifacts')
    mkdirSync(artifactRoot, { recursive: true })

    await assert.rejects(
      () => executeWriteArtifact(
        {
          relativePath: 'audiovisual_handoff/body/not-declared.md',
          content: 'nope',
        },
        {
          skillId: 'video-expert-analyzer',
          lookupSkillRoots: () => ({
            skillId: 'video-expert-analyzer',
            assetRoot: root,
            artifactRoot,
          }),
          additionalAllowedWriteTargets: [{
            root,
            relativePath: 'audiovisual_handoff/body/output.md',
          }],
        } as any,
      ),
      /not inside any writable skill artifact target|escapes sandbox root|no_root_match/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
