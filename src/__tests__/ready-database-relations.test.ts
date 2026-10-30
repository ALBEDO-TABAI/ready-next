import assert from 'node:assert/strict'
import test from 'node:test'
import { extractObjectLinks } from '../main/modules/search-engine/object-link-extract'

test('DB3 relation frontmatter must resolve equally with LF and CRLF (shared extractor regression)', () => {
  const lf = '---\n关联:\n  - "[[target]]"\n---\n正文\n'
  const extracted = (content: string) => extractObjectLinks(content).map(link => ({ kind: link.kind, rawTarget: link.rawTarget }))
  assert.deepEqual(extracted(lf), [{ kind: 'frontmatter', rawTarget: 'target' }])
  assert.deepEqual(extracted(lf.replace(/\n/g, '\r\n')), extracted(lf))
})
