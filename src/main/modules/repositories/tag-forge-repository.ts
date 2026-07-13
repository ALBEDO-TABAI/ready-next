import { randomUUID } from 'crypto'
import type { DatabaseConnection } from '../database'
import type { TagFacet, TagLexiconEntry, TagProposal, ValidatedTag } from '../tag-forge/tag-forge-policy'

export class TagForgeRepository {
  constructor(private readonly db: DatabaseConnection) {}

  listOverlay(): TagLexiconEntry[] {
    return this.db.prepare(`SELECT tag_id AS id,facet,label,aliases_json AS aliases,status FROM tag_lexicon_overlays WHERE status='active'`).all<any>().map((row)=>({ ...row, aliases:parseList(row.aliases) }))
  }

  upsertOverlay(entry: Omit<TagLexiconEntry,'status'> & {status?:'active'|'deprecated'}, now=Date.now()):void {
    this.db.prepare(`INSERT INTO tag_lexicon_overlays(tag_id,facet,label,aliases_json,definition,status,created_at,updated_at) VALUES(?,?,?,?,? ,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET facet=excluded.facet,label=excluded.label,aliases_json=excluded.aliases_json,definition=excluded.definition,status=excluded.status,updated_at=excluded.updated_at`).run(entry.id,entry.facet,entry.label,JSON.stringify(entry.aliases),'',entry.status??'active',now,now)
  }

  addPending(proposals:readonly TagProposal[],sourceRunId:string|null,now=Date.now()):void {
    const insert=this.db.prepare(`INSERT INTO tag_pending_proposals(proposal_id,facet,label,evidence_code,evidence_excerpt,source_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?) ON CONFLICT(facet,label,status) DO UPDATE SET evidence_code=excluded.evidence_code,evidence_excerpt=excluded.evidence_excerpt,source_run_id=excluded.source_run_id,updated_at=excluded.updated_at`)
    for(const p of proposals) insert.run(randomUUID(),p.facet,p.label,p.evidenceCode,p.evidenceExcerpt??null,sourceRunId,now,now)
  }

  listPending():Array<{proposalId:string;facet:TagFacet;label:string;evidenceCode:string;evidenceExcerpt:string|null}> {
    return this.db.prepare(`SELECT proposal_id AS proposalId,facet,label,evidence_code AS evidenceCode,evidence_excerpt AS evidenceExcerpt FROM tag_pending_proposals WHERE status='pending' ORDER BY created_at`).all<any>()
  }
  listRejected():Array<{facet:TagFacet;label:string}> {
    return this.db.prepare(`SELECT facet,label FROM tag_pending_proposals WHERE status='rejected' ORDER BY updated_at`).all<any>()
  }
  reviewPending(proposalId:string,decision:'approve'|'reject',now=Date.now()):void {
    const row=this.db.prepare(`SELECT facet,label FROM tag_pending_proposals WHERE proposal_id=? AND status='pending'`).get<{facet:TagFacet;label:string}>(proposalId);if(!row)throw new Error('pending proposal not found')
    if(decision==='approve'){const id=`user-${Buffer.from(`${row.facet}:${row.label}`).toString('base64url').slice(0,32)}`;this.upsertOverlay({id,facet:row.facet,label:row.label,aliases:[]},now);this.db.prepare(`UPDATE tag_pending_proposals SET status='approved',updated_at=? WHERE proposal_id=?`).run(now,proposalId)}else this.db.prepare(`UPDATE tag_pending_proposals SET status='rejected',updated_at=? WHERE proposal_id=?`).run(now,proposalId)
  }

  mintCreationReceipt(input:{sourceRunId:string;fileKey:string;createdAt?:number}):string {
    const now=input.createdAt??Date.now();const receiptId=randomUUID()
    this.db.prepare(`INSERT INTO artifact_creation_receipts(receipt_id,source_run_id,file_key,created_in_this_run,created_at,enrichment_status,updated_at) VALUES(?,?,?,1,?,'awaiting_final_save',?) ON CONFLICT(source_run_id,file_key) DO NOTHING`).run(receiptId,input.sourceRunId,input.fileKey,now,now)
    return this.db.prepare(`SELECT receipt_id AS id FROM artifact_creation_receipts WHERE source_run_id=? AND file_key=?`).get<{id:string}>(input.sourceRunId,input.fileKey)!.id
  }

  completeFinalSave(receiptId:string,hash:string,savedAt=Date.now()):void {
    const result=this.db.prepare(`UPDATE artifact_creation_receipts SET final_save_hash=?,final_saved_at=?,enrichment_status='pending',retry_error_code=NULL,updated_at=? WHERE receipt_id=? AND created_in_this_run=1`).run(hash,savedAt,savedAt,receiptId) as {changes:number}
    if(result.changes!==1) throw new Error('creation receipt not found')
  }

  getCreationReceipt(receiptId:string,sourceRunId:string):{receiptId:string;fileKey:string;status:string}|null {
    return this.db.prepare(`SELECT receipt_id AS receiptId,file_key AS fileKey,enrichment_status AS status FROM artifact_creation_receipts WHERE receipt_id=? AND source_run_id=? AND created_in_this_run=1`).get<any>(receiptId,sourceRunId)??null
  }

  getEligibleReceipt(receiptId:string,sourceRunId:string):{receiptId:string;fileKey:string;finalSaveHash:string}|null {
    return this.db.prepare(`SELECT receipt_id AS receiptId,file_key AS fileKey,final_save_hash AS finalSaveHash FROM artifact_creation_receipts WHERE receipt_id=? AND source_run_id=? AND created_in_this_run=1 AND final_save_hash IS NOT NULL AND enrichment_status IN ('pending','failed_retryable')`).get<any>(receiptId,sourceRunId)??null
  }

  markReceipt(receiptId:string,status:'completed'|'completed_sparse'|'failed_retryable'|'failed_terminal',errorCode:string|null=null,now=Date.now()):void {
    this.db.prepare(`UPDATE artifact_creation_receipts SET enrichment_status=?,retry_error_code=?,updated_at=? WHERE receipt_id=?`).run(status,errorCode,now,receiptId)
  }

  listAssignments(fileKey:string):Array<ValidatedTag & {ownership:'manual'|'automatic';suppressed:boolean;source:string}> {
    return this.db.prepare(`SELECT tag_id AS tagId,facet,label,COALESCE(confidence,1) AS confidence,COALESCE(evidence_code,'manual') AS evidenceCode,'exact' AS resolution,ownership,suppressed,source FROM file_tag_assignments WHERE file_key=?`).all<any>(fileKey).map((row)=>({...row,suppressed:Boolean(row.suppressed)}))
  }

  reconcileAssignments(input:{fileKey:string;frontmatterTags:readonly string[];knownEntries:readonly TagLexiconEntry[];now?:number}):void {
    const now=input.now??Date.now();const present=new Set(input.frontmatterTags.map(key));const existing=this.listAssignments(input.fileKey)
    for(const assignment of existing){
      if(assignment.ownership==='automatic'&&!present.has(key(assignment.label))) this.db.prepare(`UPDATE file_tag_assignments SET suppressed=1,readback_at=?,updated_at=? WHERE file_key=? AND tag_id=?`).run(now,now,input.fileKey,assignment.tagId)
      if(assignment.ownership==='manual'&&!present.has(key(assignment.label))) this.db.prepare(`DELETE FROM file_tag_assignments WHERE file_key=? AND tag_id=?`).run(input.fileKey,assignment.tagId)
    }
    for(const label of input.frontmatterTags){const entry=input.knownEntries.find((item)=>item.status==='active'&&(key(item.label)===key(label)||item.aliases.some((alias)=>key(alias)===key(label))));if(!entry)continue;const owned=existing.find((item)=>item.tagId===entry.id);if(owned){if(owned.suppressed)this.upsertAssignment(input.fileKey,{tagId:entry.id,facet:entry.facet,label:entry.label,confidence:1,evidenceCode:'frontmatter_reconcile',resolution:'exact'},'user','manual',null,now);continue}this.upsertAssignment(input.fileKey,{tagId:entry.id,facet:entry.facet,label:entry.label,confidence:1,evidenceCode:'frontmatter_reconcile',resolution:'exact'},'user','manual',null,now)}
  }

  replaceAutomaticAssignments(fileKey:string,tags:readonly ValidatedTag[],source:'tag_forge_auto'|'tag_forge_explicit',lexiconVersion:string,now=Date.now()):void {
    const retained=new Set(tags.map((tag)=>tag.tagId));this.db.prepare(`DELETE FROM file_tag_assignments WHERE file_key=? AND ownership='automatic' AND suppressed=0 AND tag_id NOT IN (${tags.length?tags.map(()=>'?').join(','):"''"})`).run(fileKey,...retained)
    for(const tag of tags)this.upsertAssignment(fileKey,tag,source,'automatic',lexiconVersion,now)
  }

  markReadback(fileKey:string,at=Date.now()):void {this.db.prepare(`UPDATE file_tag_assignments SET readback_at=?,updated_at=? WHERE file_key=? AND suppressed=0`).run(at,at,fileKey)}

  private upsertAssignment(fileKey:string,tag:ValidatedTag,source:string,ownership:string,version:string|null,now:number):void {this.db.prepare(`INSERT INTO file_tag_assignments(file_key,tag_id,facet,label,source,ownership,suppressed,lexicon_version,evidence_code,confidence,validated_at,written_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?) ON CONFLICT(file_key,tag_id) DO UPDATE SET facet=excluded.facet,label=excluded.label,source=excluded.source,ownership=excluded.ownership,suppressed=0,lexicon_version=excluded.lexicon_version,evidence_code=excluded.evidence_code,confidence=excluded.confidence,validated_at=excluded.validated_at,written_at=excluded.written_at,updated_at=excluded.updated_at`).run(fileKey,tag.tagId,tag.facet,tag.label,source,ownership,version,tag.evidenceCode,tag.confidence,now,now,now)}
}
function parseList(raw:string):string[]{try{const v=JSON.parse(raw);return Array.isArray(v)?v.map(String):[]}catch{return[]}}
function key(value:string):string{return value.trim().toLocaleLowerCase()}
