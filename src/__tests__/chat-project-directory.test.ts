import { resolveTestObject } from './utils/object-resolver'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalProjectDirectory, withProjectDirectorySelection, projectDirectoryContext } from '../main/modules/agent-control/codex-runtime/chat-project-directory'
import { ArtifactMaterializer } from '../main/modules/tools/artifact-materializer'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'

test('project directory validates real folders and supplies the existing resource and export chain', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-project-')))
  try {
    writeFileSync(join(root, 'file.txt'), 'fixture')
    assert.equal(canonicalProjectDirectory(root), root)
    assert.equal(canonicalProjectDirectory(null), null)
    assert.throws(() => canonicalProjectDirectory(join(root, 'file.txt')))
    assert.throws(() => canonicalProjectDirectory(join(root, 'missing')))
    assert.throws(() => canonicalProjectDirectory('relative'))
    const selections = withProjectDirectorySelection([], root)
    const resolved = await resolveCodexExplicitResources({ resolveLocalObject: resolveTestObject, selections, resolveSkill: () => null })
    assert.equal(resolved.authorities[0].path, root)
    assert.equal(resolved.requestResources[0].kind, 'folder_reference')
    const authority = resolved.authorities[0]
    const staging = realpathSync(mkdtempSync(join(tmpdir(), 'ready-project-stage-')))
    try {
      const materializer = new ArtifactMaterializer(staging)
      const artifact = await materializer.write({ readyRunId: 'project-run', itemId: 'report.md',
        actionId: 'project-write', expectedVersion: null, mode: 'replace', content: '项目文件落盘验证' })
      const receipt = await materializer.exportVersion({ actionReadyRunId: 'project-run', sourceReadyRunId: 'project-run',
        itemId: 'report.md', actionId: 'project-export', version: artifact.version, expectedSha256: artifact.logicalSha256,
        destination: { logicalResourceId: authority.logicalResourceId, path: authority.path,
          ...authority.directoryIdentity!, policyEpoch: authority.policyEpoch }, targetRelativePath: 'report.md' })
      assert.equal(receipt.readbackVerified, true)
      assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), '项目文件落盘验证')
    } finally { rmSync(staging, { recursive: true, force: true }) }
    assert.deepEqual(withProjectDirectorySelection(selections, '/ignored'), selections)
    assert.deepEqual(withProjectDirectorySelection([], null), [])
    assert.match(projectDirectoryContext(null), /未选择/)
    assert.ok(projectDirectoryContext(root).includes(root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
