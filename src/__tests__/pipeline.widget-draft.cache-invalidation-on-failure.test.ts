import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)

describe('widget-draft cache invalidation on failure contract (P3 T6 · Gap M)', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('buildDocumentPipelineWidgetDraft returns {draft, cacheable} (not a bare draft)', () => {
    assert.match(
      source,
      /private async buildDocumentPipelineWidgetDraft\([\s\S]*?\): Promise<\{ draft: DocumentWidgetDraft; cacheable: boolean \}>/,
    )
  })

  it('schema-valid first attempt is tagged cacheable:true', () => {
    assert.match(
      source,
      /if \(firstAttempt\.errors\.length === 0\) \{\s*return \{ draft: firstAttempt\.draft, cacheable: true \}/,
    )
  })

  it('schema-valid second attempt is tagged cacheable:true', () => {
    assert.match(
      source,
      /if \(secondAttempt\.errors\.length === 0\) \{\s*return \{ draft: secondAttempt\.draft, cacheable: true \}/,
    )
  })

  it('create-mode fallback draft is tagged cacheable:false so fallbacks never pollute the cache', () => {
    assert.match(
      source,
      /const fallbackDraft = this\.buildFallbackDocumentWidgetDraft\(\{[\s\S]*?\}\)[\s\S]*?return \{ draft: fallbackDraft, cacheable: false \}/,
    )
  })

  it('exposes a deleteCachedWidgetDraft method that clears the session cache by key', () => {
    assert.match(
      source,
      /private deleteCachedWidgetDraft\(\s*sessionId: string,\s*question: string,\s*job: DocumentTaskJob,\s*snapshot: ActiveDocumentSnapshot,\s*reason: string,\s*\): void \{/,
    )
    const deleteBody = source.match(
      /private deleteCachedWidgetDraft\([\s\S]*?\n {2}\}/,
    )
    assert.ok(deleteBody, 'deleteCachedWidgetDraft body not found')
    const body = deleteBody![0]
    assert.match(
      body,
      /this\.sessionWidgetDraftCaches\.(?:set|delete)\(/,
      'session cache must be updated on invalidation',
    )
    assert.doesNotMatch(
      body,
      /this\.documentWidgetDraftCache/,
      'shared cross-session cache has been removed; invalidation must only touch sessionWidgetDraftCaches',
    )
    assert.match(
      body,
      /document widget draft cache invalidated key=\$\{key\} reason=\$\{reason\}/,
      'invalidation must log a structured line',
    )
  })

  it('compose_widget only stores drafts when built.cacheable is true', () => {
    assert.match(
      source,
      /currentDraft = built\.draft\s*if \(built\.cacheable\) \{\s*this\.storeCachedDocumentWidgetDraft\(/,
    )
  })

  it('compose_widget wraps the build call in try/catch that invalidates the key before rethrowing', () => {
    const composeBlock = source.match(
      /const cachedDraft = this\.getCachedDocumentWidgetDraft\([\s\S]*?emitStepUpdate\(\{[\s\S]*?step: 'compose_widget',\s*status: 'completed'/,
    )
    assert.ok(composeBlock, 'compose_widget block not found')
    const body = composeBlock![0]
    assert.match(
      body,
      /\} catch \(err\) \{\s*this\.deleteCachedWidgetDraft\(\s*params\.sessionId,\s*params\.job\.instruction,\s*params\.job,\s*targetSnapshot,\s*'build-failed',\s*\)\s*throw err/,
      'build failure must invalidate the cacheKey and rethrow',
    )
  })

  it('the runDocumentWidgetPipeline dep unwraps built.draft (does not leak {draft, cacheable} outward)', () => {
    assert.match(
      source,
      /buildWidgetDraft: async \(\{ question, snapshot, insight, plan, signal \}\) => \{\s*const built = await this\.buildDocumentPipelineWidgetDraft\(\{[\s\S]*?\}\)[\s\S]*?return built\.draft\s*\}/,
    )
  })
})
