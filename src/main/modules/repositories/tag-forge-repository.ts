import type { DatabaseConnection } from '../database/connection'
import { createHash, randomUUID } from 'crypto'

import type { TagFacet, TagLexiconEntry, TagProposal, ValidatedTag } from '../tag-forge/tag-forge-policy'

export interface TagPendingIdentity {
  sourceRunId: string | null
  batchId: string
  itemId: string
  scopeId?: string | null
}

export interface TagPendingProposalRow {
  proposalId: string
  facet: TagFacet
  label: string
  evidenceCode: string
  evidenceExcerpt: string | null
  sourceRunId: string | null
  batchId: string
  itemId: string
  scopeId: string | null
  status: 'pending' | 'approved' | 'merged' | 'rejected' | 'dismissed'
}

interface TagAssignmentSnapshot {
  fileKey:string;tagId:string;facet:TagFacet;label:string;source:string;ownership:'manual'|'automatic';suppressed:number
  lexiconVersion:string|null;evidenceCode:string|null;confidence:number|null;validatedAt:number|null;writtenAt:number|null;readbackAt:number|null;updatedAt:number
}

export interface TagCreationReceiptRecord {
  receiptId:string
  sourceRunId:string
  fileKey:string
  status:string
  finalSaveHash:string|null
  validationJson:string|null
}

export class TagForgeRepository {
  constructor(private readonly db: DatabaseConnection) {}

  listOverlay(): TagLexiconEntry[] {
    return this.db.prepare(`SELECT tag_id AS id,facet,label,aliases_json AS aliases,definition,status FROM tag_lexicon_overlays WHERE status='active'`).all<any>().map((row)=>({ ...row, aliases:parseList(row.aliases) }))
  }

  upsertOverlay(entry: Omit<TagLexiconEntry,'status'> & {status?:'active'|'deprecated'}, now=Date.now()):void {
    const id=tagOverlayId(entry.facet,entry.label)
    const legacy=this.db.prepare(`SELECT tag_id AS id FROM tag_lexicon_overlays WHERE facet=? AND label=? AND tag_id<>?`).get<{id:string}>(entry.facet,entry.label,id)
    if(legacy)throw Object.assign(new Error('legacy overlay id requires migration'),{code:'legacy_overlay_id_requires_migration'})
    this.db.prepare(`INSERT INTO tag_lexicon_overlays(tag_id,facet,label,aliases_json,definition,status,created_at,updated_at) VALUES(?,?,?,?,? ,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET facet=excluded.facet,label=excluded.label,aliases_json=excluded.aliases_json,definition=excluded.definition,status=excluded.status,updated_at=excluded.updated_at`).run(id,entry.facet,entry.label,JSON.stringify(entry.aliases),entry.definition??'',entry.status??'active',now,now)
  }

  removeOverlayIfUnassigned(tagId:string):void {
    this.db.prepare(`DELETE FROM tag_lexicon_overlays WHERE tag_id=? AND NOT EXISTS(SELECT 1 FROM file_tag_assignments WHERE tag_id=?)`).run(tagId,tagId)
  }

  addPending(proposals:readonly TagProposal[],identity:TagPendingIdentity|string|null,now=Date.now()):TagPendingProposalRow[] {
    const scoped=normalizePendingIdentity(identity)
    const insert=this.db.prepare(`INSERT INTO tag_pending_proposals(proposal_id,facet,label,evidence_code,evidence_excerpt,source_run_id,batch_id,item_id,scope_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(batch_id,item_id,facet,label,status) DO UPDATE SET evidence_code=excluded.evidence_code,evidence_excerpt=excluded.evidence_excerpt,source_run_id=excluded.source_run_id,scope_id=excluded.scope_id,updated_at=excluded.updated_at`)
    for(const p of proposals) insert.run(randomUUID(),p.facet,p.label,p.evidenceCode,p.evidenceExcerpt??null,scoped.sourceRunId,scoped.batchId,scoped.itemId,scoped.scopeId??null,now,now)
    return this.listPending(scoped)
  }

  listPending(identity?:TagPendingIdentity):TagPendingProposalRow[] {
    const select=`SELECT proposal_id AS proposalId,facet,label,evidence_code AS evidenceCode,evidence_excerpt AS evidenceExcerpt,source_run_id AS sourceRunId,batch_id AS batchId,item_id AS itemId,scope_id AS scopeId,status FROM tag_pending_proposals WHERE status='pending'`
    return identity
      ? this.db.prepare(`${select} AND batch_id=? AND item_id=? ORDER BY created_at`).all<any>(identity.batchId,identity.itemId)
      : this.db.prepare(`${select} ORDER BY created_at`).all<any>()
  }
  listRejected(identity:TagPendingIdentity|string|null=null):Array<{facet:TagFacet;label:string}> {
    const scoped=normalizePendingIdentity(identity)
    return scoped.batchId!=='unscoped'||scoped.itemId!=='unscoped'
      ? this.db.prepare(`SELECT facet,label FROM tag_pending_proposals WHERE status='rejected' OR (status='dismissed' AND batch_id=? AND item_id=?) ORDER BY updated_at`).all<any>(scoped.batchId,scoped.itemId)
      : this.db.prepare(`SELECT facet,label FROM tag_pending_proposals WHERE status='rejected' ORDER BY updated_at`).all<any>()
  }
  reviewPending(proposalId:string,decision:'approve'|'reject'|'dismiss',now=Date.now()):void {
    const row=this.db.prepare(`SELECT facet,label,status FROM tag_pending_proposals WHERE proposal_id=?`).get<{facet:TagFacet;label:string;status:string}>(proposalId);if(!row)throw new Error('pending proposal not found')
    const target=decision==='approve'?'approved':decision==='reject'?'rejected':'dismissed'
    if(row.status===target)return
    if(row.status!=='pending')throw new Error('pending proposal already reviewed')
    if(decision==='approve')this.upsertOverlay({id:tagOverlayId(row.facet,row.label),facet:row.facet,label:row.label,aliases:[]},now)
    this.db.prepare(`UPDATE tag_pending_proposals SET status=?,updated_at=? WHERE proposal_id=?`).run(target,now,proposalId)
  }

  mintCreationReceipt(input:{sourceRunId:string;fileKey:string;createdAt?:number}):string {
    const now=input.createdAt??Date.now();const receiptId=randomUUID()
    this.db.prepare(`INSERT INTO artifact_creation_receipts(receipt_id,source_run_id,file_key,created_in_this_run,created_at,enrichment_status,updated_at) VALUES(?,?,?,1,?,'awaiting_final_save',?) ON CONFLICT(source_run_id,file_key) DO NOTHING`).run(receiptId,input.sourceRunId,input.fileKey,now,now)
    return this.db.prepare(`SELECT receipt_id AS id FROM artifact_creation_receipts WHERE source_run_id=? AND file_key=?`).get<{id:string}>(input.sourceRunId,input.fileKey)!.id
  }

  storeCreationValidation(receiptId:string,hash:string,validationJson:string,now=Date.now()):void {
    const result=this.db.prepare(`UPDATE artifact_creation_receipts SET final_save_hash=?,validation_json=?,enrichment_status='pending',retry_error_code=NULL,updated_at=? WHERE receipt_id=? AND created_in_this_run=1 AND enrichment_status<>'completed'`).run(hash,validationJson,now,receiptId) as {changes:number}
    if(result.changes!==1)throw new Error('creation receipt not recoverable')
  }

  getCreationReceipt(receiptId:string,sourceRunId:string):TagCreationReceiptRecord|null {
    return this.db.prepare(`SELECT receipt_id AS receiptId,source_run_id AS sourceRunId,file_key AS fileKey,enrichment_status AS status,final_save_hash AS finalSaveHash,validation_json AS validationJson FROM artifact_creation_receipts WHERE receipt_id=? AND source_run_id=? AND created_in_this_run=1`).get<TagCreationReceiptRecord>(receiptId,sourceRunId)??null
  }

  findOpenCreationReceipt(sourceRunId:string,fileKey:string):TagCreationReceiptRecord|null {
    return this.db.prepare(`SELECT receipt_id AS receiptId,source_run_id AS sourceRunId,file_key AS fileKey,enrichment_status AS status,final_save_hash AS finalSaveHash,validation_json AS validationJson FROM artifact_creation_receipts WHERE source_run_id=? AND file_key=? AND created_in_this_run=1 AND enrichment_status IN ('awaiting_final_save','pending','failed_retryable')`).get<TagCreationReceiptRecord>(sourceRunId,fileKey)??null
  }

  findRecoverableCreationReceipt(fileKey:string):TagCreationReceiptRecord|null {
    return this.db.prepare(`SELECT receipt_id AS receiptId,source_run_id AS sourceRunId,file_key AS fileKey,enrichment_status AS status,final_save_hash AS finalSaveHash,validation_json AS validationJson FROM artifact_creation_receipts WHERE file_key=? AND created_in_this_run=1 AND enrichment_status IN ('awaiting_final_save','pending','failed_retryable') ORDER BY updated_at DESC LIMIT 1`).get<TagCreationReceiptRecord>(fileKey)??null
  }

  supersedeCreationReceipt(receiptId:string,now=Date.now()):void {
    this.markReceipt(receiptId,'failed_terminal','superseded_by_recovery',now)
  }

  markReceipt(receiptId:string,status:'completed'|'failed_retryable'|'failed_terminal',errorCode:string|null=null,now=Date.now()):void {
    this.db.prepare(`UPDATE artifact_creation_receipts SET enrichment_status=?,retry_error_code=?,updated_at=? WHERE receipt_id=?`).run(status,errorCode,now,receiptId)
  }

  listAssignments(fileKey:string):Array<ValidatedTag & {ownership:'manual'|'automatic';suppressed:boolean;source:string}> {
    return this.db.prepare(`SELECT tag_id AS tagId,facet,label,COALESCE(confidence,1) AS confidence,COALESCE(evidence_code,'manual') AS evidenceCode,'exact' AS resolution,ownership,suppressed,source FROM file_tag_assignments WHERE file_key=?`).all<any>(fileKey).map((row)=>({...row,suppressed:Boolean(row.suppressed)}))
  }

  snapshotAssignments(fileKey:string):TagAssignmentSnapshot[] {
    return this.db.prepare(`SELECT file_key AS fileKey,tag_id AS tagId,facet,label,source,ownership,suppressed,lexicon_version AS lexiconVersion,evidence_code AS evidenceCode,confidence,validated_at AS validatedAt,written_at AS writtenAt,readback_at AS readbackAt,updated_at AS updatedAt FROM file_tag_assignments WHERE file_key=?`).all<TagAssignmentSnapshot>(fileKey)
  }

  restoreAssignments(fileKey:string,snapshot:readonly TagAssignmentSnapshot[]):void {
    this.db.prepare(`DELETE FROM file_tag_assignments WHERE file_key=?`).run(fileKey)
    const insert=this.db.prepare(`INSERT INTO file_tag_assignments(file_key,tag_id,facet,label,source,ownership,suppressed,lexicon_version,evidence_code,confidence,validated_at,written_at,readback_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for(const row of snapshot)insert.run(row.fileKey,row.tagId,row.facet,row.label,row.source,row.ownership,row.suppressed,row.lexiconVersion,row.evidenceCode,row.confidence,row.validatedAt,row.writtenAt,row.readbackAt,row.updatedAt)
  }

  reconcileAssignments(input:{fileKey:string;frontmatterTags:readonly string[];workflowState?:string|null;knownEntries:readonly TagLexiconEntry[];now?:number}):void {
    const labels=[...input.frontmatterTags,...(input.workflowState?[input.workflowState]:[])];const now=input.now??Date.now();const present=new Set(labels.map(key));const existing=this.listAssignments(input.fileKey)
    for(const assignment of existing){
      if(assignment.ownership==='automatic'&&!present.has(key(assignment.label))) this.db.prepare(`UPDATE file_tag_assignments SET suppressed=1,readback_at=?,updated_at=? WHERE file_key=? AND tag_id=?`).run(now,now,input.fileKey,assignment.tagId)
      if(assignment.ownership==='manual'&&!present.has(key(assignment.label))) this.db.prepare(`DELETE FROM file_tag_assignments WHERE file_key=? AND tag_id=?`).run(input.fileKey,assignment.tagId)
    }
    for(const label of labels){const entry=input.knownEntries.find((item)=>item.status==='active'&&(key(item.label)===key(label)||item.aliases.some((alias)=>key(alias)===key(label))));if(!entry)continue;const owned=existing.find((item)=>item.tagId===entry.id);if(owned){if(owned.suppressed)this.upsertAssignment(input.fileKey,{tagId:entry.id,facet:entry.facet,label:entry.label,confidence:1,evidenceCode:'frontmatter_reconcile',resolution:'exact'},'user','manual',null,now);continue}this.upsertAssignment(input.fileKey,{tagId:entry.id,facet:entry.facet,label:entry.label,confidence:1,evidenceCode:'frontmatter_reconcile',resolution:'exact'},'user','manual',null,now)}
  }

  replaceAutomaticAssignments(fileKey:string,tags:readonly ValidatedTag[],source:'tag_forge_auto'|'tag_forge_explicit',lexiconVersion:string,now=Date.now(),preservedManualTagIds?:ReadonlySet<string>):void {
    const retained=new Set(tags.map((tag)=>tag.tagId));const manual=preservedManualTagIds??new Set(this.listAssignments(fileKey).filter((item)=>item.ownership==='manual').map((item)=>item.tagId));this.db.prepare(`DELETE FROM file_tag_assignments WHERE file_key=? AND ownership='automatic' AND suppressed=0 AND tag_id NOT IN (${tags.length?tags.map(()=>'?').join(','):"''"})`).run(fileKey,...retained)
    for(const tag of tags){if(!manual.has(tag.tagId))this.upsertAssignment(fileKey,tag,source,'automatic',lexiconVersion,now)}
  }

  markReadback(fileKey:string,at=Date.now()):void {this.db.prepare(`UPDATE file_tag_assignments SET readback_at=?,updated_at=? WHERE file_key=? AND suppressed=0`).run(at,at,fileKey)}

  private upsertAssignment(fileKey:string,tag:ValidatedTag,source:string,ownership:string,version:string|null,now:number):void {this.db.prepare(`INSERT INTO file_tag_assignments(file_key,tag_id,facet,label,source,ownership,suppressed,lexicon_version,evidence_code,confidence,validated_at,written_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?) ON CONFLICT(file_key,tag_id) DO UPDATE SET facet=excluded.facet,label=excluded.label,source=excluded.source,ownership=excluded.ownership,suppressed=0,lexicon_version=excluded.lexicon_version,evidence_code=excluded.evidence_code,confidence=excluded.confidence,validated_at=excluded.validated_at,written_at=excluded.written_at,updated_at=excluded.updated_at`).run(fileKey,tag.tagId,tag.facet,tag.label,source,ownership,version,tag.evidenceCode,tag.confidence,now,now,now)}
}
export function tagOverlayId(facet:TagFacet,label:string):string{return `user-${createHash('sha256').update(`${facet}\0${label.normalize('NFKC').trim().toLowerCase()}`).digest('hex')}`}
function parseList(raw:string):string[]{try{const v=JSON.parse(raw);return Array.isArray(v)?v.map(String):[]}catch{return[]}}
function key(value:string):string{return value.trim().toLocaleLowerCase()}
function normalizePendingIdentity(identity:TagPendingIdentity|string|null):TagPendingIdentity{
  if(identity&&typeof identity==='object')return identity
  const sourceRunId=typeof identity==='string'&&identity?identity:null
  return{sourceRunId,batchId:sourceRunId?`run:${sourceRunId}`:'unscoped',itemId:sourceRunId??'unscoped',scopeId:null}
}
