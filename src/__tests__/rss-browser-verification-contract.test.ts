import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss mode escalates login or verification failures into a modal handoff prompt', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  assert.match(rssMode, /import Modal from '\.\.\/\.\.\/components\/ui\/Modal'/)
  assert.match(rssMode, /import \{ useModal \} from '\.\.\/\.\.\/components\/ui\/useModal'/)
  assert.match(rssMode, /const \{ modalProps, showConfirm \} = useModal\(\)/)
  assert.match(rssMode, /showConfirm\(/)
  assert.match(rssMode, /statusAction\.reason === 'login' \|\| statusAction\.reason === 'verify'/)
  assert.match(rssMode, /<Modal \{\.\.\.modalProps\} \/>/)
})
