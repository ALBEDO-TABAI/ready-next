import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  fileIoGroup,
  type FileIoGroupDeps,
} from '../main/modules/document-engine/ipc/file-io-group'
import {
  __setWebContentsProviderForTests,
} from '../main/modules/document-engine/ipc/directory-change-broadcast'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function registerHandlers(deps: FileIoGroupDeps): Map<string, HandlerFn> {
  const handlers = new Map<string, HandlerFn>()
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler() {},
  } as unknown as IpcMain
  fileIoGroup.register(ipc, deps)
  return handlers
}

function createDeps(overrides: Partial<FileIoGroupDeps> = {}): FileIoGroupDeps {
  return {
    useMock: false,
    getDocumentWriteIndexHook: () => null,
    writeDocumentEditableText: async () => ({ success: true }),
    saveDocumentWithDialog: async () => ({ success: true, path: '/tmp/ready-saved.md' }),
    resolveDialogWindow: () => null,
    getBrowserWindowFromWebContents: () => null,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showItemInFolder: async () => undefined,
    openShellPath: async () => '',
    validateWorkspaceRoot: () => ({ ok: true }),
    ...overrides,
  } as FileIoGroupDeps
}

test('document file writes broadcast directory changes for file tree refresh', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-doc-broadcast-'))
  const sent: Array<{ channel: string; payload: { paths: string[] } }> = []
  __setWebContentsProviderForTests(() => [
    { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload: payload as { paths: string[] } }) },
  ])
  try {
    const writePath = join(tmpRoot, 'written.md')
    const saveAsPath = join(tmpRoot, 'saved-as.md')
    const createPath = join(tmpRoot, 'created.md')
    const handlers = registerHandlers(createDeps({
      saveDocumentWithDialog: async () => ({ success: true, path: saveAsPath }),
    }))
    const event = { sender: {} } as IpcMainInvokeEvent

    await handlers.get('document:write')?.(event, { path: writePath, content: '# Written\n' })
    await handlers.get('document:saveAs')?.(event, { content: '# Saved\n', suggestedName: 'saved-as.md' })
    await handlers.get('document:createFile')?.(event, createPath)

    assert.deepEqual(
      sent.map((item) => [item.channel, item.payload.paths]),
      [
        ['document:directoryChanged', [dirname(writePath)]],
        ['document:directoryChanged', [dirname(saveAsPath)]],
        ['document:directoryChanged', [dirname(createPath)]],
      ],
    )
  } finally {
    __setWebContentsProviderForTests(null)
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
