import { resolveTestObject } from './utils/object-resolver'
// npm run verify:chat-pasted-image runs this in Electron's main process with the real image decoder.
import assert from 'node:assert/strict'
import test from 'node:test'
import { app, nativeImage } from 'electron'
import { mkdtemp, readFile, realpath, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { savePastedImage } from '../main/modules/claude-bridge/chat-pasted-image'
import { MAX_PASTED_IMAGE_BYTES } from '../shared/chat-pasted-image'
import { createLocalPathAttachment } from '../renderer/components/agent/chat-panel/attachments-helpers'
import { buildCodexIngressInputWithDiagnostics } from '../renderer/modules/agent/messageComposer'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'

test('clipboard image bytes persist privately and reach native image input through the actual composer', async () => {
  await app.whenReady()
  const root = await mkdtemp(join(tmpdir(), 'ready-pasted-image-'))
  try {
    const image = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 })
    for (const bytes of [image.toPNG(), image.toJPEG(90)]) {
      const file = await savePastedImage(root, new Uint8Array(bytes))
      const saved = await readFile(file.path)
      assert.deepEqual(nativeImage.createFromBuffer(saved).getSize(), { width: 16, height: 16 })
      assert.equal((await stat(file.path)).mode & 0o777, 0o600)
      const composed = await buildCodexIngressInputWithDiagnostics({ content: '', attachments: [createLocalPathAttachment(file)] })
      const resolved = await resolveCodexExplicitResources({ resolveLocalObject: resolveTestObject, selections: composed.resources!, resolveSkill: () => null })
      assert.deepEqual(resolved.input, [{ type: 'localImage', path: await realpath(file.path), detail: null }])
      assert.equal(JSON.stringify(composed).includes('base64'), false)
      assert.deepEqual(await readFile(file.path), saved)
    }
    const before = await readdir(join(root, 'chat-attachments', 'pasted'))
    await assert.rejects(savePastedImage(root, new Uint8Array()), /没有可用/)
    await assert.rejects(savePastedImage(root, Buffer.from('not an image')), /无法读取/)
    await assert.rejects(savePastedImage(root, new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1)), /20 MB/)
    assert.deepEqual(await readdir(join(root, 'chat-attachments', 'pasted')), before)
  } catch (error) {
    process.exitCode = 1
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.after(() => app.exit(process.exitCode ? 1 : 0))
