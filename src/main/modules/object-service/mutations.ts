import { repairObjectLinks } from './link-repair'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, rename, rm, lstat, readdir, readlink, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ObjectRegistry, canonicalObjectPath, fullHash, isInside, objectTransaction, type ObjectRecord } from './registry'
import { getDocumentTabTransport, requestDocumentTab, withDocumentPathLock } from '../document-engine/document-write-service'

async function moveFile(source:string,target:string):Promise<void> {
  await mkdir(dirname(target),{recursive:true})
  try { await rename(source,target) } catch(error) {
    if(!(error && typeof error==='object' && 'code' in error && error.code==='EXDEV'))throw error
    const temporary=`${target}.ready-move-${randomUUID()}`
    try {
      await cp(source,temporary,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true})
      const verify=async(from:string,to:string):Promise<void>=>{
        const info=await lstat(from)
        if(info.isSymbolicLink()){if(await readlink(from)!==await readlink(to))throw new Error('Cross-device symlink readback mismatch');return}
        if(info.isDirectory()){for(const entry of await readdir(from))await verify(join(from,entry),join(to,entry));return}
        if(fullHash(from)!==fullHash(to))throw new Error('Cross-device copy readback mismatch')
        const file=await open(to,'r');try{await file.sync()}finally{await file.close()}
      }
      await verify(source,temporary)
      await rename(temporary,target)
      try { await rm(source,{recursive:true}) } catch(failure) {await rm(target,{recursive:true});throw failure}
    } finally { if(existsSync(temporary))await rm(temporary,{recursive:true}) }
  }
}

export class ObjectMutations {
  constructor(readonly registry:ObjectRegistry) {}
  async move(source:string,target:string, options:{authorizedRoots?:readonly string[];operationId?:string}={}):Promise<void> {
    if(options.operationId) {
      const prior=this.registry.db.prepare('SELECT source_id,old_path,new_path,state FROM object_move_operations WHERE id=?').get<{source_id:string;old_path:string;new_path:string;state:string}>(options.operationId)
      if(prior) {
        const {canonicalObjectPath}=await import('./registry')
        const oldPath=canonicalObjectPath(source),newPath=canonicalObjectPath(target)
        if(prior.old_path!==oldPath||prior.new_path!==newPath)throw new Error('Move operation ID reused for a different move')
        if(options.authorizedRoots && [oldPath,newPath].some(path=>!options.authorizedRoots!.some(root=>isInside(canonicalObjectPath(root),path))))throw new Error('Move is outside authorized roots')
        if(prior.state!=='committed')this.recover()
        if(this.registry.get(prior.source_id)?.current_path===newPath)return
        const state=this.registry.db.prepare('SELECT state FROM object_move_operations WHERE id=?').get<{state:string}>(options.operationId)?.state
        if(state!=='rolled_back')throw new Error('Previous move no longer owns the target location')
      }
    }
    await withDocumentPathLock(source,async canonical=>{
      // Resolve both real locations before touching either file; a source grant never grants the destination.
      const { realpathSync } = await import('node:fs')
      const destination=canonicalObjectPath(target)
      if(options.authorizedRoots) {
        const roots=options.authorizedRoots.map(root=>realpathSync(root))
        if(!roots.some(root=>isInside(root,canonical))||!roots.some(root=>isInside(root,destination)))throw new Error('Move is outside authorized roots')
      }
      if(existsSync(destination))throw new Error('Target already exists; replacing a different object requires an explicit replacement operation')
      const object=this.registry.register(canonical)
      if(object.identity_state==='conflict')throw new Error('Object identity conflict')
      const directory=object.kind==='directory'
      if(directory)this.registry.scan(canonical)
      const objects=this.registry.list().filter(row=>row.current_path && isInside(canonical,row.current_path))
      const transport=getDocumentTabTransport();const id=options.operationId??randomUUID();const prepared:string[]=[]
      try {
        if(transport)for(const row of objects.filter(row=>row.kind==='markdown')) {
          prepared.push(row.current_path!)
          const reply=await requestDocumentTab(transport,{id:`${id}:${row.id}`,path:row.current_path!,deadline:Date.now()+30000,phase:'prepare',operation:{type:'appendBlock',markdown:''},diskContent:readFileSync(row.current_path!,'utf8')},10000)
          if(!reply.ok || reply.tabs.some(tab=>tab.isDirty))throw new Error('dirty_conflict: save open changes before moving this object')
        }
        const db=this.registry.db
        db.prepare(`INSERT INTO object_move_operations(id,source_id,old_path,new_path,state,objects_json) VALUES (?,?,?,?,'prepared',?) ON CONFLICT(id) DO UPDATE SET state='prepared',objects_json=excluded.objects_json,error=NULL WHERE object_move_operations.state='rolled_back'`).run(id,object.id,canonical,destination,JSON.stringify(objects))
        let published=false
        try {
          if(canonicalObjectPath(source)!==canonical || canonicalObjectPath(target)!==destination)throw new Error('Move location changed during preparation')
          if(existsSync(destination))throw new Error('Target already exists')
          if(objects.some(row=>row.kind!=='directory' && fullHash(row.current_path!)!==row.content_hash))throw new Error('version_conflict: source changed during move preparation')
          await moveFile(canonical,destination);published=true
          db.prepare("UPDATE object_move_operations SET state='file_published' WHERE id=?").run(id)
          this.commitMove(id,canonical,destination,objects)
        } catch(error) {
          try {
            if(published)await moveFile(destination,canonical)
            this.registry.reconcile(objects.map(row=>row.current_path!))
            db.prepare("UPDATE object_move_operations SET state='rolled_back',error=? WHERE id=?").run(String(error),id)
          } catch(rollback) {
            db.prepare("UPDATE object_move_operations SET state='recovery_required',error=? WHERE id=?").run(`${String(error)}; rollback: ${String(rollback)}`,id)
            throw new Error(`Move requires recovery: ${String(rollback)}`)
          }
          throw error
        }
      } finally {
        if(transport)for(const path of prepared) {
          const row=objects.find(row=>row.current_path===path)!
          let failure:string|undefined
          try {
            const reply=await requestDocumentTab(transport,{id:`${id}:${row.id}`,path,deadline:Date.now()+10000,phase:'release'},10000)
            if(!reply.ok)failure=reply.message
          } catch(error) { failure=String(error) }
          if(failure) {
            this.registry.db.prepare('UPDATE object_move_operations SET error=? WHERE id=?').run(`Tab release incomplete: ${failure}`,id)
            console.warn('[objects] tab release incomplete; see durable move receipt',id,failure)
          }
        }
      }
    })
    await repairObjectLinks(this.registry)
  }
  private commitMove(id:string,source:string,target:string,objects:readonly ObjectRecord[]):void {
    const db=this.registry.db
    objectTransaction(db,()=>{
      this.registry.captureLinks()
      for(const row of objects) {
        const next=target+row.current_path!.slice(source.length)
        db.prepare("UPDATE object_link_repairs SET state='pending' WHERE source_id=? OR target_id=?").run(row.id,row.id)
        db.prepare("UPDATE objects SET current_path=?,path_key=?,last_known_path=?,workspace_id=?,revision=revision+1 WHERE id=?").run(next,next,next,this.registry.workspace(next),row.id)
        db.prepare(`INSERT INTO file_move_receipts(receipt_id,object_id,workspace_root,old_path,new_path,move_kind,moved_at,operation_id) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(object_id,old_path,new_path) DO UPDATE SET moved_at=excluded.moved_at,operation_id=excluded.operation_id`).run(randomUUID(),row.id,this.workspaceRoot(row.workspace_id),row.current_path,next,row.kind==='directory'?'directory':'file',Date.now(),id)
      }
      for(const row of db.prepare('SELECT project_key,anchor_path FROM project_identities WHERE anchor_path IS NOT NULL').all<{project_key:string;anchor_path:string}>()) {
        if(isInside(source,row.anchor_path))db.prepare('UPDATE project_identities SET anchor_path=?,updated_at=? WHERE project_key=?').run(target+row.anchor_path.slice(source.length),Date.now(),row.project_key)
      }
      this.registry.reconcile(objects.map(row=>target+row.current_path!.slice(source.length)))
      this.registry.syncProjection()
      db.prepare("UPDATE object_move_operations SET state='committed' WHERE id=?").run(id)
    })
  }
  private workspaceRoot(id:number|null):string {return id===null?'':this.registry.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{root:string}>(id)?.root??''}
  recover():void {
    const db=this.registry.db
    for(const op of db.prepare("SELECT * FROM object_move_operations WHERE state IN ('prepared','file_published','recovery_required')").all<{id:string;old_path:string;new_path:string;objects_json:string}>()) {
      const objects: ObjectRecord[]=JSON.parse(op.objects_json)
      if(existsSync(op.old_path)&&!existsSync(op.new_path)) {
        this.registry.reconcile(objects.map(row=>row.current_path!));db.prepare("UPDATE object_move_operations SET state='rolled_back' WHERE id=?").run(op.id)
      } else if(!existsSync(op.old_path)&&existsSync(op.new_path)&&objects.every(row=>row.kind==='directory'||fullHash(op.new_path+row.current_path!.slice(op.old_path.length))===row.content_hash)) {
        this.commitMove(op.id,op.old_path,op.new_path,objects)
      } else {
        db.prepare("UPDATE object_move_operations SET state='recovery_required',error='Locations or versions changed during recovery' WHERE id=?").run(op.id)
        throw new Error(`Object move requires recovery: ${op.id}`)
      }
    }
  }
}
