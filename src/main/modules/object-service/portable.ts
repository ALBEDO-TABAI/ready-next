import { readFileSync } from 'node:fs'
import { setFrontmatterFields } from '../../../shared/document-operations'
import type { DatabaseConnection } from '../database/connection'
import type { PortableIdentityResult } from '../../../shared/object-identity'
import { commitDocumentOperation, documentVersion, getDocumentWriteDependencies, type DocumentWriteDependencies } from '../document-engine/document-write-service'
import { ObjectRegistry } from './registry'

async function writePortableIdentity(registry:ObjectRegistry,objectId:string,dependencies:DocumentWriteDependencies|null=getDocumentWriteDependencies()):Promise<PortableIdentityResult> {
  const fail=(code:Extract<PortableIdentityResult,{ok:false}>['code'],message:string):PortableIdentityResult=>({ok:false,objectId,portable:false,code,message})
  const object=registry.get(objectId)
  if(!object?.current_path || object.status!=='present')return fail('not_present','Object is not present')
  if(object.kind!=='markdown')return fail('not_markdown','Portable identity writing only supports Markdown')
  if(object.identity_state==='conflict')return fail('identity_conflict','Embedded identity is in conflict; local relationship retained')
  if(!dependencies)return fail('operation_failed','Document write service is not initialized')
  try {
    const current=registry.register(object.current_path)
    if(current.id!==objectId || current.identity_state==='conflict')return fail('identity_conflict','Object identity changed')
    const db=registry.db
    const pending=db.prepare("SELECT original,published_hash,state FROM object_identity_writes WHERE object_id=? AND state IN ('prepared','file_published','recovery_required')").get<{original:string;published_hash:string;state:string}>(objectId)
    if(current.identity_state==='portable' && !pending)return {ok:true,objectId,portable:true}
    const original=readFileSync(current.current_path!,'utf8')
    if(pending && documentVersion(original)!==pending.published_hash && original!==pending.original)return fail('version_conflict','Interrupted identity write encountered a newer file; recovery material retained')
    let published:string
    try {published=setFrontmatterFields(original,{set:{ready_id:objectId}})} catch(error) {return fail('operation_failed',String(error))}
    db.prepare("INSERT INTO object_identity_writes(object_id,original,published_hash,state) VALUES (?,?,?,'prepared') ON CONFLICT(object_id) DO UPDATE SET original=excluded.original,published_hash=excluded.published_hash,state='prepared',error=NULL").run(objectId,pending?.original??original,documentVersion(published))
    await commitDocumentOperation({path:current.current_path!,expectedVersion:current.content_hash??undefined,operation:{type:'setFrontmatterFields',set:{ready_id:objectId}},origin:'persistent_relationship'},dependencies,{
      published:async()=>{db.prepare("UPDATE object_identity_writes SET state='file_published' WHERE object_id=?").run(objectId);const verified=registry.register(current.current_path!);if(verified.id!==objectId || verified.identity_state!=='portable')throw new Error('Portable identity readback mismatch')},
      rollback:async()=>{registry.register(current.current_path!);db.prepare("UPDATE object_identity_writes SET state='rolled_back' WHERE object_id=?").run(objectId)},
      complete:()=>{db.prepare("UPDATE object_identity_writes SET state='committed' WHERE object_id=?").run(objectId)},
    })
    return {ok:true,objectId,portable:true}
  } catch(error) {
    registry.db.prepare("UPDATE object_identity_writes SET state='recovery_required',error=? WHERE object_id=? AND state IN ('prepared','file_published')").run(String(error),objectId)
    const code=error instanceof Error && 'code' in error ? error.code : undefined
    switch(code) {
      case 'version_conflict':case 'dirty_conflict':case 'operation_failed':case 'write_failed':case 'readback_mismatch':return fail(code,String(error))
      default:return fail('operation_failed',String(error))
    }
  }
}

const pendingWrites=new WeakMap<DatabaseConnection,Map<string,Promise<PortableIdentityResult>>>()
export function ensurePortableIdentity(registry:ObjectRegistry,objectId:string,dependencies:DocumentWriteDependencies|null=getDocumentWriteDependencies()):Promise<PortableIdentityResult> {
  let writes=pendingWrites.get(registry.db)
  if(!writes){writes=new Map();pendingWrites.set(registry.db,writes)}
  const existing=writes.get(objectId)
  if(existing)return existing
  const result=writePortableIdentity(registry,objectId,dependencies)
  writes.set(objectId,result)
  result.then(()=>writes.delete(objectId),()=>writes.delete(objectId))
  return result
}
