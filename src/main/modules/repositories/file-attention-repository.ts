import { createHash, randomUUID } from 'crypto'
import type { DatabaseConnection } from '../database'

const DAY_MS = 86_400_000

export interface FileAttentionRollup {
  fileKey: string
  observedSince: number
  historyCoverageStart: number
  historyCoverageEnd: number
  firstOpenAt: number | null
  lastOpenAt: number | null
  firstSaveAt: number | null
  lastSaveAt: number | null
  firstReadAt: number | null
  lastReadAt: number | null
  openCount: number
  saveCount: number
  activeDays: number[]
  readingMs: number
  latestProgress: number | null
  maxProgress: number | null
  progressKind: string | null
  markCount: number
  linkInCount: number
  linkOutCount: number
  lastSurfacedAt: number | null
  existsState: 'present' | 'missing' | 'archived'
}

export interface ProjectIntentFact {
  intentId: string
  projectKey: string
  fileKeys: string[]
  kind: 'continue' | 'prepare' | 'deliver' | 'read'
  source: 'calendar' | 'task' | 'user_confirmed'
  notBefore: number | null
  dueAt: number | null
  expiresAt: number
  status: 'active' | 'completed' | 'cancelled' | 'expired'
  evidenceCode: string
  evidenceRef: string | null
}

type RollupRow = {
  file_key: string; observed_since: number; history_coverage_start: number; history_coverage_end: number
  first_open_at: number | null; last_open_at: number | null; first_save_at: number | null; last_save_at: number | null
  first_read_at: number | null; last_read_at: number | null; open_count: number; save_count: number
  active_days_json: string; reading_ms: number; latest_progress: number | null; max_progress: number | null
  progress_kind: string | null; mark_count: number; link_in_count: number; link_out_count: number
  last_surfaced_at: number | null; exists_state: FileAttentionRollup['existsState']
  backfilled_at: number | null
}

export class FileAttentionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  backfill(workspaceRoots: readonly string[], now = Date.now()): void {
    const roots = [...new Set(workspaceRoots)]
    if (!roots.length) return
    const placeholders = roots.map(() => '?').join(',')
    const eligibleFileKeys = this.db.prepare(`
      SELECT f.file_key AS fileKey
      FROM file_identities f
      LEFT JOIN file_attention_rollups r ON r.file_key=f.file_key
      WHERE f.workspace_root IN (${placeholders}) AND r.backfilled_at IS NULL
    `).all<{fileKey:string}>(...roots).map((row)=>row.fileKey)
    if (eligibleFileKeys.length === 0) {
      this.refreshMarks()
      return
    }
    const eligibleSlots=eligibleFileKeys.map(()=>'?').join(',')
    this.db.prepare(`UPDATE file_attention_rollups SET
      observed_since=9223372036854775807,
      history_coverage_start=9223372036854775807,
      history_coverage_end=0,
      first_open_at=NULL,last_open_at=NULL,first_save_at=NULL,last_save_at=NULL,
      first_read_at=NULL,last_read_at=NULL,open_count=0,save_count=0,
      active_days_json='[]',reading_ms=0,latest_progress=NULL,max_progress=NULL,progress_kind=NULL
      WHERE file_key IN (${eligibleSlots})`).run(...eligibleFileKeys)
    const events = this.db.prepare(`SELECT fi.file_key AS fileKey, e.event_type AS kind, e.created_at AS at,
      NULL AS activeMs, NULL AS progress, NULL AS progressKind
      FROM file_activity_events e JOIN file_identities fi
        ON fi.workspace_root=e.workspace_root AND fi.current_path=e.path
      WHERE e.workspace_root IN (${placeholders}) AND fi.file_key IN (${eligibleSlots})
      UNION ALL
      SELECT fi.file_key, 'read', s.ended_at, s.active_ms, s.progress_end, s.progress_kind
      FROM document_reading_sessions s JOIN file_identities fi
        ON fi.workspace_root=s.workspace_root AND fi.current_path=s.path
      WHERE s.workspace_root IN (${placeholders}) AND fi.file_key IN (${eligibleSlots})
      ORDER BY at`).all<{fileKey:string;kind:'open'|'save'|'read';at:number;activeMs:number|null;progress:number|null;progressKind:string|null}>(...roots,...eligibleFileKeys,...roots,...eligibleFileKeys)
    for (const event of events) this.applyEvent(event, now, true)
    this.db.prepare(`UPDATE file_attention_rollups SET backfilled_at=?, history_coverage_end=MAX(history_coverage_end, ?) WHERE file_key IN (${eligibleSlots})`).run(now,now,...eligibleFileKeys)
    this.refreshMarks()
  }

  recordActivity(fileKey: string, kind: 'open' | 'save', at: number): void {
    this.applyEvent({ fileKey, kind, at, activeMs: null, progress: null, progressKind: null }, at, false)
  }

  recordReading(fileKey: string, at: number, activeMs: number, progress: number | null, progressKind: string | null): void {
    this.applyEvent({ fileKey, kind: 'read', at, activeMs, progress, progressKind }, at, false)
  }

  list(workspaceRoots: readonly string[]): FileAttentionRollup[] {
    if (!workspaceRoots.length) return []
    const placeholders = workspaceRoots.map(() => '?').join(',')
    return this.db.prepare(`SELECT r.* FROM file_attention_rollups r JOIN file_identities f ON f.file_key=r.file_key
      WHERE f.workspace_root IN (${placeholders})`).all<RollupRow>(...workspaceRoots).map(toRollup)
  }

  createIntent(input: Omit<ProjectIntentFact, 'intentId' | 'status'> & { intentId?: string }): ProjectIntentFact {
    const now = Date.now()
    const intentId = input.intentId ?? randomUUID()
    if (input.expiresAt <= now) throw new Error('intent must expire in the future')
    this.db.prepare(`INSERT INTO project_intent_facts
      (intent_id,project_key,file_keys_json,kind,source,not_before,due_at,expires_at,status,evidence_code,evidence_ref,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'active',?,?,?,?)`).run(intentId,input.projectKey,JSON.stringify(input.fileKeys),input.kind,input.source,input.notBefore,input.dueAt,input.expiresAt,input.evidenceCode.slice(0,64),input.evidenceRef?.slice(0,256)??null,now,now)
    return { ...input, intentId, status: 'active' }
  }

  listActiveIntents(projectKeys: readonly string[], now = Date.now()): ProjectIntentFact[] {
    this.expireIntents(now)
    if (!projectKeys.length) return []
    const placeholders = projectKeys.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM project_intent_facts WHERE project_key IN (${placeholders}) AND status='active' AND expires_at>? AND (not_before IS NULL OR not_before<=?)`).all<any>(...projectKeys,now,now).map(toIntent)
  }

  setIntentStatus(intentId: string, status: 'completed'|'cancelled', now=Date.now()): void {
    this.db.prepare(`UPDATE project_intent_facts SET status=?, updated_at=? WHERE intent_id=? AND status='active'`).run(status,now,intentId)
  }

  recordSnapshot(projects: readonly {projectKey:string;fileKeys?:string[];bucket:string;reasonCodes:string[];rank:number;score:number;machineName:boolean}[], generatedAt:number, context:{workspaceRoots:readonly string[];rejectionReasons:Record<string,number>}={workspaceRoots:[],rejectionReasons:{}}): void {
    const id=randomUUID();this.db.exec('BEGIN')
    try{
      this.db.prepare(`INSERT INTO file_emergence_snapshot_generations(snapshot_id,root_scope_hash,generated_at,visible_count,machine_name_count,rejection_reasons_json) VALUES(?,?,?,?,?,?)`).run(id,rootScopeHash(context.workspaceRoots),generatedAt,projects.length,projects.filter((project)=>project.machineName).length,JSON.stringify(context.rejectionReasons))
      const insert=this.db.prepare(`INSERT INTO file_emergence_prediction_snapshots (snapshot_id,project_key,bucket,reason_codes_json,generated_at,rank,score,machine_name,file_keys_json) VALUES (?,?,?,?,?,?,?,?,?)`)
      for(const p of projects) insert.run(id,p.projectKey,p.bucket,JSON.stringify([...new Set(p.reasonCodes)]),generatedAt,p.rank,p.score,p.machineName?1:0,JSON.stringify([...new Set(p.fileKeys??[])]))
      const surface=this.db.prepare(`UPDATE file_attention_rollups SET last_surfaced_at=?,updated_at=? WHERE file_key IN (SELECT file_key FROM project_identity_members WHERE project_key=?)`)
      for(const p of projects) surface.run(generatedAt,generatedAt,p.projectKey)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }

  private expireIntents(now:number):void {
    this.db.prepare(`UPDATE project_intent_facts SET status='expired',updated_at=? WHERE status='active' AND expires_at<=?`).run(now,now)
    this.db.prepare(`UPDATE project_intent_facts SET status='cancelled',updated_at=? WHERE status='active' AND project_key IN (SELECT project_key FROM project_identities WHERE status IN ('hidden','merged'))`).run(now)
    this.db.prepare(`UPDATE project_intent_facts
      SET status='cancelled',updated_at=?
      WHERE status='active' AND EXISTS (
        SELECT 1
        FROM json_each(project_intent_facts.file_keys_json) key
        LEFT JOIN file_identities f ON f.file_key=key.value
        LEFT JOIN file_attention_rollups r ON r.file_key=key.value
        WHERE f.file_key IS NULL OR f.status<>'present' OR COALESCE(r.exists_state,'present')='archived'
      )`).run(now)
  }

  private applyEvent(e:{fileKey:string;kind:'open'|'save'|'read';at:number;activeMs:number|null;progress:number|null;progressKind:string|null}, now:number, _backfill:boolean):void {
    const existing=this.db.prepare('SELECT * FROM file_attention_rollups WHERE file_key=?').get<RollupRow>(e.fileKey)
    const days=new Set(existing ? JSON.parse(existing.active_days_json) as number[] : []); days.add(Math.floor(e.at/DAY_MS)*DAY_MS)
    this.db.prepare(`INSERT INTO file_attention_rollups (file_key,observed_since,history_coverage_start,history_coverage_end,active_days_json,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(file_key) DO UPDATE SET observed_since=MIN(observed_since,excluded.observed_since),history_coverage_start=MIN(history_coverage_start,excluded.history_coverage_start),history_coverage_end=MAX(history_coverage_end,excluded.history_coverage_end),active_days_json=excluded.active_days_json,updated_at=excluded.updated_at`).run(e.fileKey,e.at,e.at,e.at,JSON.stringify([...days].sort()),now)
    if(e.kind==='open'||e.kind==='save') this.db.prepare(`UPDATE file_attention_rollups SET first_${e.kind}_at=COALESCE(first_${e.kind}_at,?),last_${e.kind}_at=MAX(COALESCE(last_${e.kind}_at,0),?),${e.kind}_count=${e.kind}_count+1 WHERE file_key=?`).run(e.at,e.at,e.fileKey)
    else this.db.prepare(`UPDATE file_attention_rollups SET first_read_at=COALESCE(first_read_at,?),last_read_at=MAX(COALESCE(last_read_at,0),?),reading_ms=reading_ms+?,latest_progress=?,max_progress=MAX(COALESCE(max_progress,0),COALESCE(?,0)),progress_kind=COALESCE(?,progress_kind) WHERE file_key=?`).run(e.at,e.at,e.activeMs??0,e.progress,e.progress,e.progressKind,e.fileKey)
  }

  private refreshMarks():void {
    this.db.prepare(`UPDATE file_attention_rollups SET mark_count=(SELECT COUNT(*) FROM document_marks m JOIN file_identities f ON f.current_path=m.document_path WHERE f.file_key=file_attention_rollups.file_key)`).run()
  }
}

export function rootScopeHash(workspaceRoots:readonly string[]):string{return createHash('sha256').update([...new Set(workspaceRoots)].sort().join('\u0000')).digest('hex')}

function toRollup(r:RollupRow):FileAttentionRollup{return{fileKey:r.file_key,observedSince:r.observed_since,historyCoverageStart:r.history_coverage_start,historyCoverageEnd:r.history_coverage_end,firstOpenAt:r.first_open_at,lastOpenAt:r.last_open_at,firstSaveAt:r.first_save_at,lastSaveAt:r.last_save_at,firstReadAt:r.first_read_at,lastReadAt:r.last_read_at,openCount:r.open_count,saveCount:r.save_count,activeDays:JSON.parse(r.active_days_json),readingMs:r.reading_ms,latestProgress:r.latest_progress,maxProgress:r.max_progress,progressKind:r.progress_kind,markCount:r.mark_count,linkInCount:r.link_in_count,linkOutCount:r.link_out_count,lastSurfacedAt:r.last_surfaced_at,existsState:r.exists_state}}
function toIntent(r:any):ProjectIntentFact{return{intentId:r.intent_id,projectKey:r.project_key,fileKeys:JSON.parse(r.file_keys_json),kind:r.kind,source:r.source,notBefore:r.not_before,dueAt:r.due_at,expiresAt:r.expires_at,status:r.status,evidenceCode:r.evidence_code,evidenceRef:r.evidence_ref}}
