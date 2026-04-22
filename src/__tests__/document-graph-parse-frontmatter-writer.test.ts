import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFrontmatter } from '../shared/document-graph-parse-frontmatter-writer'
import { parseDocumentGraph } from '../shared/document-graph-parse'

describe('writeFrontmatter', () => {
  it('prepends a new frontmatter block when none exists', () => {
    const result = writeFrontmatter('# heading\n\nbody', { tags: ['alpha'], title: 'T' })
    assert.ok(result.startsWith('---\n'))
    const parsed = parseDocumentGraph(result)
    assert.deepEqual(parsed.frontmatter, { tags: ['alpha'], title: 'T' })
    assert.ok(parsed.body.includes('# heading'))
  })

  it('replaces an existing frontmatter block in place', () => {
    const source = '---\ntitle: old\ntags:\n  - a\n---\n\n# heading\n'
    const result = writeFrontmatter(source, { title: 'new', tags: ['a', 'b'] })
    assert.ok(result.startsWith('---\n'))
    // Exactly one frontmatter block
    const matches = result.match(/^---\s*$/gm)
    assert.ok(matches && matches.length === 2, 'expected exactly one --- fence pair')
    const parsed = parseDocumentGraph(result)
    assert.equal(parsed.frontmatter?.title, 'new')
    assert.deepEqual(parsed.frontmatter?.tags, ['a', 'b'])
    assert.ok(parsed.body.includes('# heading'))
  })

  it('round-trips via parseDocumentGraph → writeFrontmatter → parseDocumentGraph', () => {
    const source = '---\ntags:\n  - project\n---\n\nbody #inline'
    const parsed = parseDocumentGraph(source)
    const nextContent = writeFrontmatter(source, { ...(parsed.frontmatter ?? {}), tags: ['project', 'new'] })
    const reparsed = parseDocumentGraph(nextContent)
    assert.ok(reparsed.tags.includes('project'))
    assert.ok(reparsed.tags.includes('new'))
    assert.ok(reparsed.tags.includes('inline'))
  })
})
