const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkRendererErrorFriendliness } = require('../check-renderer-error-friendliness.cjs')

test('passes when agent error surfaces use friendly mapping', () => {
  withFixture({
    'src/renderer/stores/useAgent.ts': "import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'\nconst copy = mapBackendErrorToFriendly({ error: result.error || '', errorKind: result.errorKind }).friendlyMessage\n",
    'src/renderer/modules/agent/runtimeDriver.ts': "import { mapBackendErrorToFriendly } from './error-message-mapping'\nconst copy = mapBackendErrorToFriendly({ error: data.error, errorKind: data.errorKind }).friendlyMessage\n",
    'src/renderer/components/agent/SoftFailureCapsule.tsx': "import { mapBackendErrorToFriendly } from '../../modules/agent/error-message-mapping'\nconst copy = mapBackendErrorToFriendly({ error: softError.message, errorKind: softError.errorKind }).friendlyMessage\n",
  }, (root) => {
    const result = checkRendererErrorFriendliness({ root })
    assert.equal(result.ok, true, result.errors.join('\n'))
  })
})

test('fails when send failure writes result.error directly into chat content', () => {
  withFixture({
    'src/renderer/stores/useAgent.ts': "const message = { content: `${result.error || '发送失败'}` }\n",
    'src/renderer/modules/agent/runtimeDriver.ts': "import { mapBackendErrorToFriendly } from './error-message-mapping'\n",
    'src/renderer/components/agent/SoftFailureCapsule.tsx': "import { mapBackendErrorToFriendly } from '../../modules/agent/error-message-mapping'\n",
  }, (root) => {
    const result = checkRendererErrorFriendliness({ root })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /useAgent/)
  })
})

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-renderer-errors-'))
  try {
    for (const [file, text] of Object.entries(files)) write(root, file, text)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
