import type { DatabaseConnection } from '../database/connection'
import { randomUUID } from 'crypto'


export type FileEmergenceFeedbackAction='rename'|'not_related'|'snooze'|'hide'|'restore'
export interface FileEmergenceFeedbackRecord{feedbackId:string;projectKey:string;action:FileEmergenceFeedbackAction;evidenceCutoff:number|null;snoozeUntil:number|null;createdAt:number}
export interface FileEmergenceFeedbackDecision{visible:boolean;reason:'not_related'|'snoozed'|'hidden'|null;until:number|null}

export class FileEmergenceFeedbackRepository{
  constructor(private readonly db:DatabaseConnection){}

  record(input:{projectKey:string;action:FileEmergenceFeedbackAction;evidenceCutoff?:number|null;snoozeUntil?:number|null;createdAt?:number}):FileEmergenceFeedbackRecord{
    const project=this.db.prepare(`SELECT project_key AS projectKey FROM project_identities WHERE project_key=?`).get<{projectKey:string}>(input.projectKey)
    if(!project)throw new Error('project identity not found')
    const createdAt=input.createdAt??Date.now();const snoozeUntil=input.snoozeUntil??null
    if(input.action==='snooze'&&(!snoozeUntil||snoozeUntil<=createdAt))throw new Error('snoozeUntil must be in the future')
    if(input.action==='not_related'&&(!Number.isFinite(input.evidenceCutoff)||Number(input.evidenceCutoff)<0))throw new Error('evidenceCutoff is required for not_related')
    const feedbackId=randomUUID()
    this.db.exec('BEGIN')
    try{
      this.db.prepare(`INSERT INTO file_emergence_feedback(feedback_id,project_key,action,evidence_cutoff,snooze_until,created_at) VALUES(?,?,?,?,?,?)`).run(feedbackId,input.projectKey,input.action,input.evidenceCutoff??null,snoozeUntil,createdAt)
      if(input.action==='hide')this.db.prepare(`UPDATE project_identities SET status='hidden',updated_at=? WHERE project_key=?`).run(createdAt,input.projectKey)
      if(input.action==='snooze')this.db.prepare(`UPDATE project_identities SET status='snoozed',updated_at=? WHERE project_key=?`).run(createdAt,input.projectKey)
      if(input.action==='restore'||input.action==='not_related')this.db.prepare(`UPDATE project_identities SET status='active',updated_at=? WHERE project_key=?`).run(createdAt,input.projectKey)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
    return{feedbackId,projectKey:input.projectKey,action:input.action,evidenceCutoff:input.evidenceCutoff??null,snoozeUntil,createdAt}
  }

  resolve(projectKey:string,latestEvidenceAt:number,now=Date.now()):FileEmergenceFeedbackDecision{
    const row=this.db.prepare(`SELECT action,evidence_cutoff AS evidenceCutoff,snooze_until AS snoozeUntil FROM file_emergence_feedback WHERE project_key=? AND action<>'rename' ORDER BY created_at DESC LIMIT 1`).get<{action:FileEmergenceFeedbackAction;evidenceCutoff:number|null;snoozeUntil:number|null}>(projectKey)
    if(!row||row.action==='restore')return{visible:true,reason:null,until:null}
    if(row.action==='hide')return{visible:false,reason:'hidden',until:null}
    if(row.action==='snooze'){
      if((row.snoozeUntil??0)>now)return{visible:false,reason:'snoozed',until:row.snoozeUntil}
      this.db.prepare(`UPDATE project_identities SET status='active',updated_at=? WHERE project_key=? AND status='snoozed'`).run(now,projectKey)
      return{visible:true,reason:null,until:null}
    }
    if(row.action==='not_related'&&latestEvidenceAt<=(row.evidenceCutoff??0))return{visible:false,reason:'not_related',until:null}
    return{visible:true,reason:null,until:null}
  }

  listProjectFilePaths(projectKey:string):string[]{
    return this.db.prepare(`
      SELECT f.current_path AS path
      FROM project_identity_members m
      JOIN file_identities f ON f.file_key=m.file_key
      WHERE m.project_key=?
      ORDER BY f.current_path
    `).all<{path:string}>(projectKey).map((row)=>row.path)
  }

  listSuppressedFilePaths(workspaceRoots:readonly string[],now=Date.now()):string[]{
    if(workspaceRoots.length===0)return[]
    const slots=workspaceRoots.map(()=>'?').join(',')
    const projects=this.db.prepare(`SELECT DISTINCT p.project_key AS projectKey FROM project_identities p JOIN file_emergence_feedback f ON f.project_key=p.project_key WHERE p.workspace_root IN (${slots}) AND f.action<>'rename'`).all<{projectKey:string}>(...workspaceRoots)
    const paths=new Set<string>()
    for(const project of projects){
      const latest=this.db.prepare(`SELECT MAX(MAX(COALESCE(r.last_open_at,0),COALESCE(r.last_save_at,0)),COALESCE(r.last_read_at,0)) AS at FROM project_identity_members m LEFT JOIN file_attention_rollups r ON r.file_key=m.file_key WHERE m.project_key=?`).get<{at:number|null}>(project.projectKey)?.at??0
      if(!this.resolve(project.projectKey,latest,now).visible)for(const path of this.listProjectFilePaths(project.projectKey))paths.add(path)
    }
    return [...paths]
  }

  listSuppressed(workspaceRoots:readonly string[],now=Date.now()):Array<{projectKey:string;displayName:string;reason:'not_related'|'snoozed'|'hidden';until:number|null}>{
    if(!workspaceRoots.length)return[];const slots=workspaceRoots.map(()=>'?').join(',')
    const rows=this.db.prepare(`
      SELECT p.project_key AS projectKey,p.display_name AS displayName,f.action,f.snooze_until AS snoozeUntil
      FROM project_identities p
      JOIN file_emergence_feedback f ON f.feedback_id=(
        SELECT feedback_id FROM file_emergence_feedback
        WHERE project_key=p.project_key AND action<>'rename'
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE p.workspace_root IN (${slots})
    `).all<{projectKey:string;displayName:string;action:FileEmergenceFeedbackAction;snoozeUntil:number|null}>(...workspaceRoots)
    const suppressed:Array<{projectKey:string;displayName:string;reason:'not_related'|'snoozed'|'hidden';until:number|null}>=[]
    for(const row of rows){
      if(row.action==='hide')suppressed.push({projectKey:row.projectKey,displayName:row.displayName,reason:'hidden',until:null})
      if(row.action==='not_related')suppressed.push({projectKey:row.projectKey,displayName:row.displayName,reason:'not_related',until:null})
      if(row.action==='snooze'&&(row.snoozeUntil??0)>now)suppressed.push({projectKey:row.projectKey,displayName:row.displayName,reason:'snoozed',until:row.snoozeUntil})
    }
    return suppressed
  }

  countByAction():Record<string,number>{return Object.fromEntries(this.db.prepare(`SELECT action,COUNT(*) AS count FROM file_emergence_feedback GROUP BY action`).all<{action:string;count:number}>().map((row)=>[row.action,row.count]))}
}
