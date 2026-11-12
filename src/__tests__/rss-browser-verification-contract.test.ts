import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: RSS browser verification contract depends on BrowserView-facing integration wiring
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss mode escalates login or verification failures into a modal handoff prompt', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  // W1-T5 (B13): the prompt is the shared modal dialog of the one float host, not the retired ui/Modal.
  assert.match(rssMode, /import \{ confirmDialog \} from '\.\.\/\.\.\/components\/ui\/float\/Dialog'/)
  assert.match(rssMode, /confirmDialog\(\{ title, body: message \}\)/)
  assert.match(rssMode, /statusAction\.reason === 'login' \|\| statusAction\.reason === 'verify'/)
  assert.match(rssMode, /openForCaptureTarget\(statusAction\.url\)/)
  assert.doesNotMatch(rssMode, /components\/ui\/Modal|useModal/)
})
