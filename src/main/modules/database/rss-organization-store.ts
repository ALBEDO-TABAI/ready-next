import { randomUUID } from 'node:crypto'
import { RSS_PROCESSING_METHOD, type RSSJudgment, type RSSProcessingDefinition } from '../../../shared/rss-processing'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import { RSSDefinitionWriteSchema, RSSDefinitionDeleteSchema, RSSMembershipWriteSchema, rssArticleRevision,
  type RSSDefinition, type RSSDefinitionWrite, type RSSMembership, type RSSMembershipWrite } from '../../../shared/rss-organization'

export const rssIncludedClassificationSQL = `COALESCE(m.manual_decision,CASE WHEN r.content_revision=(i.content_revision || ':' || CASE WHEN c.item_revision=i.content_revision THEN COALESCE(c.body_revision,'none') ELSE 'none' END)
  AND r.rule_revision=d.rule_revision THEN r.decision END)=1`

type DefinitionRow = Omit<RSSDefinition, 'visible' | 'ruleRevision' | 'filterIds'> & { visible: number; rule_revision: number }

export class RSSOrganizationStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly articleRevision: (id: string) => string | null) {}
  private get db(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS organization database')
    return db
  }

  private transaction<T>(action: () => T): T {
    const db = this.db
    db.exec('SAVEPOINT rss_organization')
    try { const result = action(); db.exec('RELEASE rss_organization'); return result }
    catch (error) { db.exec('ROLLBACK TO rss_organization; RELEASE rss_organization'); throw error }
  }

  list(): RSSDefinition[] {
    const filters = this.db.prepare('SELECT f.collection_id,f.topic_id FROM rss_definition_filters f JOIN rss_definitions d ON d.id=f.topic_id ORDER BY d.position,d.id')
      .all<{ collection_id: string; topic_id: string }>()
    const byCollection = new Map<string, string[]>()
    for (const filter of filters) {
      const ids = byCollection.get(filter.collection_id) || []
      ids.push(filter.topic_id); byCollection.set(filter.collection_id, ids)
    }
    return this.db.prepare('SELECT * FROM rss_definitions ORDER BY position,id').all<DefinitionRow>().map(({ rule_revision, visible, ...row }) => ({
      ...row, ruleRevision: rule_revision, visible: visible === 1, filterIds: byCollection.get(row.id) || [],
    }))
  }

  save(input: RSSDefinitionWrite): RSSDefinition {
    const params = RSSDefinitionWriteSchema.parse(input)
    return this.transaction(() => {
      const definitions = this.list()
      const previous = params.id ? definitions.find((definition) => definition.id === params.id) : undefined
      if (params.id && (!previous || previous.revision !== params.expectedRevision)) throw new Error('栏目已变化或删除，请重新读取后修改。')
      if (previous && !['topic', 'curated'].includes(previous.kind) && params.description !== previous.description) throw new Error('阅读状态栏的筛选含义固定。')
      if ((!previous || ['topic', 'curated'].includes(previous.kind)) && !params.description) throw new Error('请填写分类或精选标准。')
      if (previous?.kind === 'all' && !params.visible) throw new Error('全部动态入口必须保留。')
      const filterIds = [...new Set(params.filterIds)]
      if (filterIds.some((id) => !definitions.some((definition) => definition.id === id && definition.kind === 'topic'))) throw new Error('关联的分类已删除或无效。')
      const id = previous?.id || randomUUID()
      if (previous) {
        this.db.prepare(`UPDATE rss_definitions SET name=?,description=?,icon=?,position=?,visible=?,revision=revision+1,
          rule_revision=rule_revision+? WHERE id=?`).run(params.name, params.description, params.icon, params.position, Number(params.visible), Number(previous.description !== params.description), id)
      } else {
        this.db.prepare(`INSERT INTO rss_definitions(id,kind,name,description,icon,position,visible) VALUES (?,'topic',?,?,?,?,?)`)
          .run(id, params.name, params.description, params.icon, params.position, Number(params.visible))
        this.db.prepare("INSERT INTO rss_definition_filters(collection_id,topic_id) VALUES ('all',?)").run(id)
        this.db.prepare("UPDATE rss_definitions SET revision=revision+1 WHERE id='all'").run()
      }
      this.db.prepare('DELETE FROM rss_definition_filters WHERE collection_id=?').run(id)
      const bindFilter = this.db.prepare('INSERT INTO rss_definition_filters(collection_id,topic_id) VALUES (?,?)')
      filterIds.forEach((topicId) => bindFilter.run(id, topicId))
      const saved = this.list()
      return saved.find((entry) => entry.id === id)!
    })
  }

  remove(input: { id: string; expectedRevision: number }): { id: string } {
    const params = RSSDefinitionDeleteSchema.parse(input)
    return this.transaction(() => {
      const previous = this.list().find((definition) => definition.id === params.id)
      if (!previous || previous.revision !== params.expectedRevision) throw new Error('栏目已变化或删除，请重新读取后修改。')
      if (previous.kind !== 'topic') throw new Error('系统阅读栏目可以改名或隐藏，不能删除。')
      this.db.prepare(`UPDATE rss_definitions SET revision=revision+1 WHERE id IN
        (SELECT collection_id FROM rss_definition_filters WHERE topic_id=?)`).run(params.id)
      this.db.prepare('DELETE FROM rss_definitions WHERE id=?').run(params.id)
      return { id: params.id }
    })
  }

  recordDigestIntake(itemId: string, now = Date.now()): void {
    const revision = this.articleRevision(itemId)
    this.db.prepare(`INSERT OR IGNORE INTO rss_digest_intake(item_id,article_revision,received_at)
      SELECT id,?,? FROM rss_items WHERE id=? AND daily_eligible=1`).run(revision, now, itemId)
    this.db.prepare(`UPDATE rss_digest_intake SET available_at=? WHERE item_id=? AND article_revision=? AND available_at IS NULL AND EXISTS
      (SELECT 1
      FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id
      JOIN rss_memberships m ON m.item_id=i.id JOIN rss_definitions d ON d.id=m.definition_id
      LEFT JOIN rss_classification_results r ON r.id=m.result_id
      WHERE i.id=? AND i.daily_eligible=1 AND d.kind='curated' AND ${rssIncludedClassificationSQL})`).run(now, itemId, revision, itemId)
  }

  setManual(input: RSSMembershipWrite): RSSMembership[] {
    const params = RSSMembershipWriteSchema.parse(input)
    return this.transaction(() => {
      if (this.articleRevision(params.itemId) !== params.expectedArticleRevision) throw new Error('文章已变化或删除，请重新读取后归类。')
      const definition = this.list().find((entry) => entry.id === params.definitionId)
      if (!definition || !['topic', 'curated'].includes(definition.kind) || definition.ruleRevision !== params.expectedRuleRevision) throw new Error('分类标准已变化，请重新读取后归类。')
      if (params.decision === null) {
        this.db.prepare('UPDATE rss_memberships SET manual_decision=NULL WHERE item_id=? AND definition_id=?').run(params.itemId, params.definitionId)
        this.db.prepare('DELETE FROM rss_memberships WHERE item_id=? AND definition_id=? AND result_id IS NULL').run(params.itemId, params.definitionId)
      } else this.db.prepare(`INSERT INTO rss_memberships(item_id,definition_id,manual_decision) VALUES (?,?,?)
        ON CONFLICT(item_id,definition_id) DO UPDATE SET manual_decision=excluded.manual_decision`).run(params.itemId, params.definitionId, Number(params.decision))
      this.recordDigestIntake(params.itemId)
      return this.memberships([params.itemId])[params.itemId] || []
    })
  }

  applyDerived(itemId: string, articleRevision: string, definitions: RSSProcessingDefinition[], decisions: RSSJudgment['decisions'], jobId: string): void {
    this.transaction(() => {
      if (this.articleRevision(itemId) !== articleRevision) throw new Error('文章已变化，不能保存旧归类。')
      const current = this.list()
      if (definitions.some((d) => !current.some((entry) => entry.id === d.id && entry.ruleRevision === d.ruleRevision))) throw new Error('分类标准已变化。')
      if (decisions.length !== definitions.length || new Set(decisions.map((d) => d.definitionId)).size !== definitions.length || decisions.some((d) => !definitions.some((entry) => entry.id === d.definitionId))) throw new Error('归类结果与本次标准不一致。')
      const save = this.db.prepare(`INSERT INTO rss_classification_results(item_id,definition_id,job_id,method,decision,origin,reason,evidence,content_revision,rule_revision)
        VALUES (?,?,?,?,?,'model',?,?,?,?) RETURNING id`)
      for (const decision of decisions) {
        const result = save.get<{ id: number }>(itemId, decision.definitionId, jobId, RSS_PROCESSING_METHOD, decision.included === null ? 2 : Number(decision.included),
          decision.reason, decision.evidence, articleRevision, definitions.find((d) => d.id === decision.definitionId)!.ruleRevision)!
        this.bindResult(itemId, decision.definitionId, result.id)
      }
      this.recordDigestIntake(itemId)
    })
  }

  private bindResult(itemId: string, definitionId: string, resultId: number): void {
    this.db.prepare(`INSERT INTO rss_memberships(item_id,definition_id,result_id) VALUES (?,?,?)
      ON CONFLICT(item_id,definition_id) DO UPDATE SET result_id=excluded.result_id WHERE result_id IS NOT excluded.result_id`).run(itemId, definitionId, resultId)
  }

  restore(itemId: string, articleRevision: string, definitions: RSSProcessingDefinition[]): boolean {
    return this.transaction(() => {
      if (this.articleRevision(itemId) !== articleRevision) throw new Error('文章已变化，不能恢复旧归类。')
      const current = this.list()
      let complete = true
      for (const definition of definitions) {
        if (!current.some((d) => d.id === definition.id && d.ruleRevision === definition.ruleRevision)) throw new Error('分类标准已变化。')
        const saved = this.db.prepare(`SELECT r.id FROM rss_classification_results r JOIN rss_processing_jobs j ON j.id=r.job_id
          WHERE r.item_id=? AND r.definition_id=? AND r.content_revision=? AND r.rule_revision=? AND r.method=? AND j.status='success'
          ORDER BY r.id DESC LIMIT 1`).get<{ id: number }>(itemId, definition.id, articleRevision, definition.ruleRevision, RSS_PROCESSING_METHOD)
        if (saved) this.bindResult(itemId, definition.id, saved.id)
        else complete = false
      }
      return complete
    })
  }

  memberships(itemIds: readonly string[]): Record<string, RSSMembership[]> {
    const result: Record<string, RSSMembership[]> = {}
    for (let offset = 0; offset < itemIds.length; offset += 500) {
      const ids = itemIds.slice(offset, offset + 500)
      const rows = this.db.prepare(`SELECT m.*,r.decision AS derived_decision,r.origin AS derived_origin,r.reason,r.evidence,r.content_revision,r.rule_revision,d.name,d.kind,d.rule_revision AS current_rule,i.content_revision AS current_source,
        c.item_revision AS body_source,c.body_revision FROM rss_memberships m LEFT JOIN rss_classification_results r ON r.id=m.result_id JOIN rss_definitions d ON d.id=m.definition_id
        JOIN rss_items i ON i.id=m.item_id LEFT JOIN rss_article_content c ON c.item_id=i.id
        WHERE m.item_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.position,d.id`).all<{
        item_id: string; definition_id: string; name: string; kind: 'topic' | 'curated'; manual_decision: number | null;
        derived_decision: number | null; derived_origin: 'legacy' | 'model' | null; reason: string | null; evidence: string | null;
        content_revision: string | null; rule_revision: number | null; current_rule: number;
        current_source: string; body_source: string | null; body_revision: string | null;
      }>(...ids)
      for (const row of rows) {
        const manual = row.manual_decision !== null
        const decision = manual ? row.manual_decision : row.derived_decision
        ;(result[row.item_id] ||= []).push({ definitionId: row.definition_id, name: row.name, kind: row.kind,
          included: decision === 0 ? false : decision === 1 ? true : null,
          origin: manual ? 'manual' : row.derived_origin || 'unclassified', reason: manual ? '手工指定' : row.reason || '尚未归类',
          evidence: manual ? null : row.evidence,
          stale: !manual && row.derived_decision !== null && (row.rule_revision !== row.current_rule || row.content_revision !== rssArticleRevision(row.current_source, row.body_source, row.body_revision)),
          ruleRevision: manual ? null : row.rule_revision, currentRuleRevision: row.current_rule, contentRevision: manual ? null : row.content_revision,
        })
      }
    }
    return result
  }
}
