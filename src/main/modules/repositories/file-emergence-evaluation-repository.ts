import type { DatabaseConnection } from '../database/connection'

import { evaluateEmergence, type EmergenceEvaluationReport, type EmergenceGeneration, type EmergencePrediction, type EmergenceReplayEvent } from '../file-emergence/evaluation'
import { FileEmergenceFeedbackRepository } from './file-emergence-feedback-repository'
import { rootScopeHash } from './file-attention-repository'

const DAY_MS = 86_400_000

export class FileEmergenceEvaluationRepository {
  constructor(private readonly db: DatabaseConnection) {}

  buildReport(workspaceRoots: readonly string[], now = Date.now()): EmergenceEvaluationReport {
    if (!workspaceRoots.length) return evaluateEmergence({ events: [], predictions: [], cutoffs: [], now })
    const slots = workspaceRoots.map(() => '?').join(',')
    const events = this.db.prepare(`
      SELECT e.object_id AS projectKey,e.created_at AS at,e.event_type AS kind,NULL AS activeMs
      FROM file_activity_events e
      WHERE e.workspace_root IN (${slots})
      UNION ALL
      SELECT s.object_id,s.ended_at,'read',s.active_ms
      FROM document_reading_sessions s
      WHERE s.workspace_root IN (${slots})
      ORDER BY at
    `).all<EmergenceReplayEvent>(...workspaceRoots, ...workspaceRoots).filter((event)=>Boolean(event.projectKey))
    const projectKeys = this.db.prepare(`SELECT project_key AS projectKey FROM project_identities WHERE workspace_root IN (${slots})`).all<{projectKey:string}>(...workspaceRoots).map((row) => row.projectKey)
    const predictions:EmergencePrediction[] = projectKeys.length ? this.db.prepare(`SELECT snapshot_id AS snapshotId,project_key AS projectKey,bucket,COALESCE(rank,9999) AS rank,generated_at AS generatedAt,reason_codes_json AS reasonCodesJson,machine_name AS machineNameValue,file_keys_json AS fileKeysJson FROM file_emergence_prediction_snapshots WHERE project_key IN (${projectKeys.map(() => '?').join(',')})`).all<{snapshotId:string;projectKey:string;bucket:string;rank:number;generatedAt:number;reasonCodesJson:string;machineNameValue:number;fileKeysJson:string}>(...projectKeys).map((row)=>({snapshotId:row.snapshotId,projectKey:row.projectKey,fileKeys:parseStringList(row.fileKeysJson),bucket:row.bucket,rank:row.rank,generatedAt:row.generatedAt,reasonCodes:parseStringList(row.reasonCodesJson),machineName:Boolean(row.machineNameValue)})) : []
    const generations=this.db.prepare(`SELECT snapshot_id AS snapshotId,generated_at AS generatedAt,visible_count AS visibleCount,machine_name_count AS machineNameCount,rejection_reasons_json AS rejectionReasonsJson FROM file_emergence_snapshot_generations WHERE root_scope_hash=? ORDER BY generated_at`).all<(EmergenceGeneration&{rejectionReasonsJson:string})>(rootScopeHash(workspaceRoots)).map((row)=>({...row,rejectionReasons:parseCounts(row.rejectionReasonsJson)}))
    const earliest = events[0]?.at ?? now
    const cutoffs: number[] = []
    for (let cutoff = earliest + 14 * DAY_MS; cutoff <= now - 7 * DAY_MS; cutoff += 7 * DAY_MS) cutoffs.push(cutoff)
    return evaluateEmergence({ events, predictions,generations, feedbackCounts: new FileEmergenceFeedbackRepository(this.db).countByAction(), cutoffs, now })
  }
}
function parseStringList(raw:string):string[]{try{const value=JSON.parse(raw);return Array.isArray(value)?value.map(String):[]}catch{return[]}}
function parseCounts(raw:string):Record<string,number>{try{const value=JSON.parse(raw);return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter((entry)=>Number.isFinite(Number(entry[1]))).map(([key,count])=>[key,Number(count)])):{} }catch{return{}}}
