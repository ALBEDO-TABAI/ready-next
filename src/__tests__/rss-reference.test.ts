import { extractProductSurfaceTargets } from '../main/modules/agent-control/codex-runtime/codex-product-surface-ingress'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { RSSReferenceSchema, rssReferencePath, rssReferencesFromEnvelope } from '../shared/rss-reference'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { DatabaseManager } from '../main/modules/database'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { settleWorkbenchRSSSelections, validateRSSResource, RSS_READ_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-rss-resources'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'
import { CodexProductRunPreparer, isPreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { readCodexPreparedActionAuthorizationEnvelope } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'

test('reference reads consume their exact stored scope and reject stale, foreign and modified references', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS reference read binding')) return
  const db = new DatabaseManager(true)
  const source = db.rss.addRSSSource({ name: 'Fixture', url: 'https://example.test/rss' })
  const row = { id: 'a', source_id: source, guid: 'a', title: 'Original', link: 'https://example.test/a', summary: 'saved source' }
  db.rss.upsertRSSItems([row])
  const article = db.rss.content.getArticle('a')!
  const query = db.rss.content.query({})
  const references = [RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'a', expectedRevision: article.revision } }),
    RSSReferenceSchema.parse({ kind: 'query', query: { ...query.query, expectedRevision: query.revision } })]
  // Codex hands references to the envelope as trusted, body-free resources (see codex-explicit-resources).
  const envelope = buildRequestEnvelope({ userText: '读取这些资料', trustedResources: references.map((reference, order) => ({
    id: randomUUID(), kind: 'rss_reference' as const, source: 'rss_context' as const, name: 'Saved reference', path: rssReferencePath(reference),
    text: '', summary: null, order, canRead: true, canWrite: false, rssReference: reference,
  })) })
  const resources = rssReferencesFromEnvelope(envelope)
  const context = { references: resources, getContent: () => db.rss.content }
  try {
    const original = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: resources[0].id }, context))
    assert.equal(original.data.text, 'saved source')
    assert.equal(original.data.article.read, false)
    assert.equal(original.referenceId, resources[0].id)
    const queried = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: resources[1].id }, context))
    assert.deepEqual(queried.data.query, query.query)
    assert.equal(queried.data.revision, query.revision)
    assert.equal(JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: crypto.randomUUID() }, context)).error, 'rss_reference_unavailable')
    assert.equal(JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: resources[1].id, search: 'different' }, context)).ok, false)
    db.rss.upsertRSSItems([{ ...row, title: 'New version' }])
    assert.equal(JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: resources[0].id }, context)).error, 'article_changed')
    assert.equal(JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: resources[1].id }, context)).error, 'cursor_stale')
    assert.equal(JSON.parse(await executeRSSTool('rss_read_article', { itemId: 'a' }, context)).data.article.title, 'New version', 'independent queries retain their original semantics')
    const denied = await executeToolCall('rss_read_reference', { referenceId: resources[0].id }, { scope: { sourceKind: 'channel' } as never,
      allowedToolNames: ['rss_read_reference'], requestEnvelope: envelope })
    assert.match(denied.text, /rss_read_not_authorized/)
  } finally { db.close() }
})



test('Codex RSS read floor survives selected methods, document narrowing and Tag Forge without adding RSS writes', () => {
  const tools = [...RSS_READ_TOOL_NAMES, 'tag_forge_apply_batch', 'document_save_tab', 'rss_fetch_updates', 'rss_analyze_item']
  const result = composeCodexTurnToolSnapshot({ resolved: workbenchTestSnapshot(tools, ['rss_fetch_updates']), authorizationId: 'rss-auth',
    authorization: buildExplicitNoSkillAuthorization('fixture'), hasRSSResource: true, exclusiveAllowSet: ['tag_forge_apply_batch'] })
  assert.deepEqual([...result.readyTurnToolAuthorization.allowedToolNames].sort(), [...RSS_READ_TOOL_NAMES, 'tag_forge_apply_batch'].sort())
  assert.throws(() => composeCodexTurnToolSnapshot({ resolved: workbenchTestSnapshot(['rss_read_article'], []), authorizationId: 'missing',
    authorization: buildExplicitNoSkillAuthorization('fixture'), hasRSSResource: true }), /rss_read_tool_surface_missing/)
})

test('Codex freezes and restores an exact saved RSS resource through the production prepared envelope', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS Codex resource binding')) return
  const db = new DatabaseManager(true)
  try {
    const source = db.rss.addRSSSource({ name: 'Source', url: 'https://resource.test/feed' })
    db.rss.upsertRSSItems([{ id: 'a', source_id: source, guid: 'a', title: 'Source', link: 'https://resource.test/a', summary: 'FULL-CONTENT-MUST-NOT-BE-INLINED' }])
    const article = db.rss.content.getArticle('a')!
    const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: article.id, expectedRevision: article.revision } })
    const resources = await resolveCodexExplicitResources({ selections: [{ kind: 'rss_reference', id: randomUUID(), name: 'Source', reference }], resolveSkill: () => null,
      resolveRssReference: (value) => validateRSSResource(db.rss, value) })
    assert.equal(resources.rssReferences.length, 1)
    assert.equal(JSON.stringify(resources.input).includes(article.summary), false)
    const snapshot = workbenchTestSnapshot([...RSS_READ_TOOL_NAMES], [...RSS_READ_TOOL_NAMES])
    const prepared = new CodexProductRunPreparer().prepare({ taskId: 'task', runId: 'run', requestId: 'request', scopeId: 'scope', aliasId: 'alias', aliasGeneration: 1,
      taskOrigin: 'user_root', runOrigin: 'initial', originUserMessageId: 'message', reservationSetId: 'reservation', reservationEvidenceDigest: 'receipt', currentInput: [textUserInput('Read source')],
      explicitResourceEnvelope: { input: resources.input, resourceRefs: resources.resourceRefs }, resourceAdditionalContext: resources.resourceRefs,
      rssReferences: resources.rssReferences, actionAdmissionRef: { headProjectionDigest: 'f'.repeat(64), actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 0 }, actionHeadIdentity: { aliasId: 'alias', aliasGeneration: 1, threadBindingId: 'binding', headRevision: 1 } }, trustedWorkbenchMode: 'rss', uncommittedTailAssignments: [], supersededUncommittedItems: [], readyMemorySnapshot: disabledReadyMemorySnapshot(),
      ...snapshot, authorizationOwnerId: 'owner', resourceOwnerId: 'owner', productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 } })
    assert.equal(prepared.ok, true); if (!prepared.ok) throw new Error(prepared.code)
    const restored = JSON.parse(JSON.stringify(prepared.prepared))
    assert.equal(isPreparedCodexProductRun(restored), true)
    const envelope = readCodexPreparedActionAuthorizationEnvelope({ prepared: restored })
    const references = rssReferencesFromEnvelope(envelope)
    assert.deepEqual(references, resources.rssReferences)
    const read = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: references[0].id }, { references, getContent: () => db.rss.content }))
    assert.equal(read.data.text, article.summary)
    restored.rssReferences[0].reference.read.expectedRevision = 'tampered'
    assert.equal(isPreparedCodexProductRun(restored), false)
    db.rss.upsertRSSItems([{ id: 'a', source_id: source, guid: 'a', title: 'Updated', link: article.link, summary: 'new' }])
    await assert.rejects(resolveCodexExplicitResources({ selections: [{ kind: 'rss_reference', id: randomUUID(), name: 'Source', reference }], resolveSkill: () => null,
      resolveRssReference: (value) => validateRSSResource(db.rss, value) }), /article_changed/)
  } finally { db.close() }
})


test('workbench RSS references follow the visible view while explicit references keep their exact version', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS workbench reference settling')) return
  const db = new DatabaseManager(true)
  try {
    const source = db.rss.addRSSSource({ name: 'Source', url: 'https://workbench.test/feed' })
    db.rss.upsertRSSItems([{ id: 'a', source_id: source, guid: 'a', title: 'First', link: 'https://workbench.test/a', summary: 'one' }])
    const view = db.rss.content.query({ limit: 1 })
    const article = db.rss.content.getArticle('a')!
    const queryRef = { kind: 'query' as const, query: { ...view.query, expectedRevision: view.revision } }
    const workbenchQuery = { kind: 'rss_reference' as const, id: randomUUID(), name: '当前筛选', reference: queryRef, origin: 'workbench' as const }
    const explicitQuery = { kind: 'rss_reference' as const, id: randomUUID(), name: '引用当前结果', reference: queryRef }
    const workbenchArticle = { kind: 'rss_reference' as const, id: randomUUID(), name: 'First', origin: 'workbench' as const,
      reference: { kind: 'article' as const, read: { itemId: 'a', expectedRevision: article.revision, offset: 0, length: 12000 } } }

    // Background work moves the workspace revision and the article body: the implicit view rebinds, nothing blocks.
    db.rss.markRSSRead('a')
    db.rss.upsertRSSItems([{ id: 'a', source_id: source, guid: 'a', title: 'First, updated', link: article.link, summary: 'two' }])
    const settled = settleWorkbenchRSSSelections({ store: db.rss, selections: [workbenchQuery, workbenchArticle, explicitQuery], threadCanReadRSS: true })
    assert.equal(settled.explicitBlocked, false)
    assert.equal(settled.selections.length, 3)
    const [rebasedQuery, rebasedArticle, keptExplicit] = settled.selections
    assert.equal('origin' in rebasedQuery, false)
    assert.equal(rebasedQuery.reference.kind === 'query' && rebasedQuery.reference.query.expectedRevision, db.rss.content.query({ limit: 1 }).revision)
    assert.equal(rebasedArticle.reference.kind === 'article' && rebasedArticle.reference.read.expectedRevision, db.rss.content.getArticle('a')!.revision)
    assert.deepEqual(keptExplicit, explicitQuery)
    assert.throws(() => validateRSSResource(db.rss, { id: explicitQuery.id, name: explicitQuery.name, reference: explicitQuery.reference }), /cursor_stale/)

    // A thread frozen before RSS read tools existed: the implicit view is dropped, an explicit reference asks for a new context.
    const frozen = settleWorkbenchRSSSelections({ store: db.rss, selections: [workbenchQuery], threadCanReadRSS: false })
    assert.deepEqual(frozen, { selections: [], explicitBlocked: false })
    assert.equal(settleWorkbenchRSSSelections({ store: db.rss, selections: [explicitQuery], threadCanReadRSS: false }).explicitBlocked, true)
  } finally { db.close() }
})

test('one referenced article supplies the current RSS action target while multiple articles remain explicit', () => {
  const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'A', expectedRevision: 'v1' } })
  const selected = { kind: 'rss_reference' as const, id: randomUUID(), name: 'Source', reference }
  assert.equal(extractProductSurfaceTargets([selected])?.rssItemId, 'A')
  assert.equal(extractProductSurfaceTargets([selected, { ...selected, id: randomUUID(), reference: { ...reference, read: { ...reference.read, itemId: 'B' } } }]), undefined)
})
