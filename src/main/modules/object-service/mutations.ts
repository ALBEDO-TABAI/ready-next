import { checkedPath, existsIgnoringCase } from '../document-drafts/files'
import { publishObjectMoves } from './events'
import { repairObjectLinks } from './link-repair'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, lstatSync, readdirSync, createReadStream } from 'node:fs'
import { cp, mkdir, rename, rm, lstat, readdir, readlink, open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ObjectRegistry, canonicalObjectPath, fullHash, isInside, objectTransaction, type ObjectRecord } from './registry'
import { documentVersion, getDocumentTabTransport, publishDocumentContent, requestDocumentTab, withDocumentPathLock } from '../document-engine/document-write-service'

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
        const file=await open(to,process.platform === 'win32' ? 'r+' : 'r');try{await file.sync()}finally{await file.close()}
      }
      await verify(source,temporary)
      await rename(temporary,target)
      try { await rm(source,{recursive:true}) } catch(failure) {await rm(target,{recursive:true});throw failure}
    } finally { if(existsSync(temporary))await rm(temporary,{recursive:true}) }
  }
}

export interface ObjectMoveGroup {
  id: string
  root: string
  /** Source boundary for a cross-workspace adoption; root remains the destination boundary. */
  sourceRoot?: string
  moves: Array<{ source: string; target: string }>
  objects: ObjectRecord[]
  status: 'present' | 'trashed'
  patch?: { path: string; original: string; content: string }
}
function validateGroupFiles(group: ObjectMoveGroup, side: 'source' | 'target'): void {
  for (const row of group.objects) {
    const move = group.moves.find(item => isInside(item.source, row.current_path!)) ?? { source: row.current_path!, target: row.current_path! }
    const path = move[side] + row.current_path!.slice(move.source.length)
    checkedPath(side === 'source' ? group.sourceRoot ?? group.root : group.root, path)
    if (row.kind !== 'directory') {
      const patched = side === 'target' && group.patch?.path === path
      if (fullHash(path) !== (patched ? documentVersion(group.patch!.content) : row.content_hash)) throw new Error('version_conflict: group contents changed')
    }
  }
}

export class ObjectMutations {
  constructor(readonly registry:ObjectRegistry) {}
  /** A page owns one durable group. No individual member publishes success. */
  async moveGroup(group: ObjectMoveGroup, afterMove?: (index: number) => void | Promise<void>, beforeMove?: () => Promise<void>): Promise<void> {
    const db = this.registry.db
    const prior = db.prepare('SELECT state,intent_json FROM object_move_groups WHERE id=?').get<{state:string;intent_json:string}>(group.id)
    if (prior && prior.intent_json !== JSON.stringify(group)) throw new Error('Group operation intent changed')
    if (prior?.state === 'committed') { const failure = await this.releaseGroupTabs(group.id,group.objects); if (failure) throw failure; return }
    if (prior && prior.state !== 'rolled_back') { await this.recoverGroups(); throw new Error('Group was interrupted and rolled back; start a new operation') }
    const files = [...new Set(group.objects.filter(row => row.kind !== 'directory').flatMap(row => {
      const move = group.moves.find(item => isInside(item.source,row.current_path!))
      return [row.current_path!, ...(move ? [move.target+row.current_path!.slice(move.source.length)] : [])]
    }))].sort()
    for (const move of group.moves) for (const [boundary, location] of [[group.sourceRoot ?? group.root, move.source], [group.root, move.target]]) {
      for (let path = location; isInside(boundary,path); path = dirname(path)) {
        if (!files.includes(path)) files.push(path)
        if (path === boundary) break
      }
    }
    files.sort()
    const locked = (i: number): Promise<void> => i < files.length ? withDocumentPathLock(files[i], () => locked(i + 1)) : execute()
    const execute = async (): Promise<void> => {
      const transport = getDocumentTabTransport(), prepared: ObjectRecord[] = []
      let releaseError: Error | undefined
      try {
        if (transport) for (const row of group.objects.filter(row => row.kind === 'markdown')) {
          prepared.push(row)
          const reply = await requestDocumentTab(transport, { id: `${group.id}:${row.id}`, path: row.current_path!, deadline: Date.now()+30000,
            phase: 'prepare', operation: { type: 'appendBlock', markdown: '' }, diskContent: readFileSync(row.current_path!, 'utf8') }, 10000)
          if (!reply.ok || reply.tabs.some(tab => tab.isDirty)) throw new Error('dirty_conflict: save open changes before moving this page')
        }
        for (const row of group.objects) {
          const current = this.registry.get(row.id)
          if (!current || (current.current_path ?? current.last_known_path) !== row.current_path || current.status !== row.status) throw new Error('Object ownership changed during preparation')
        }
        validateGroupFiles(group, 'source')
        for (const move of group.moves) {
          checkedPath(group.sourceRoot ?? group.root, move.source); checkedPath(group.root, move.target)
          if (existsIgnoringCase(move.target)) throw new Error('name_collision: target exists')
          if (isInside(move.source, move.target)) throw new Error('Cannot move a page inside itself')
        }
        db.prepare("INSERT INTO object_move_groups VALUES (?,?,'prepared',NULL) ON CONFLICT(id) DO UPDATE SET state='prepared',error=NULL").run(group.id, JSON.stringify(group))
        try {
          await beforeMove?.()
          for (const [index, move] of group.moves.entries()) {
            // Exclusive creation, including on another volume. The journal owns both locations until removal.
            await this.copyGroupMember(group.id, move.source, move.target)
            if (group.patch?.path === move.target) await this.writeOwned(group.id,move.target,group.patch.content)
            for (const row of group.objects.filter(row => row.current_path && isInside(move.source,row.current_path))) {
              if (row.kind !== 'directory' && fullHash(row.current_path!) !== row.content_hash) throw new Error('version_conflict: source changed while copying')
            }
            const expected = new Set(group.objects.filter(row => row.current_path && isInside(move.source,row.current_path)).map(row => row.current_path))
            const verifyMembers = (path: string): void => {
              if (!expected.has(path)) throw new Error('version_conflict: a new member appeared while copying')
              if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) verifyMembers(join(path,name))
            }
            verifyMembers(move.source)
            await rm(move.source, { recursive: true })
            await afterMove?.(index)
          }
          if (group.patch && !group.moves.length) await publishDocumentContent(group.patch.path,group.patch.content)
          validateGroupFiles(group, 'target')
          objectTransaction(db, () => {
            this.registry.captureLinks()
            for (const row of group.objects) {
              const move = group.moves.find(item => isInside(item.source, row.current_path!)) ?? { source: row.current_path!, target: row.current_path! }
              const next = move.target + row.current_path!.slice(move.source.length)
              if (group.status === 'present') db.prepare("UPDATE object_link_repairs SET state='pending' WHERE source_id=? OR target_id=?").run(row.id,row.id)
              db.prepare('UPDATE objects SET status=?,current_path=?,path_key=?,last_known_path=?,workspace_id=?,content_hash=?,revision=revision+1 WHERE id=?')
                .run(group.status, group.status === 'present' ? next : null, group.status === 'present' ? next : null, next,
                  this.registry.workspace(next), row.kind === 'directory' ? null : fullHash(next), row.id)
              if (group.sourceRoot) db.prepare('UPDATE document_drafts SET vault_root=?,revision=revision+1,updated_at=? WHERE object_id=?').run(group.root,Date.now(),row.id)
              if (group.patch?.path === next) db.prepare('UPDATE object_link_repairs SET source_hash=? WHERE source_id=?').run(fullHash(next),row.id)
              db.prepare(`INSERT INTO file_move_receipts(receipt_id,object_id,workspace_root,old_path,new_path,move_kind,moved_at,operation_id) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(object_id,old_path,new_path) DO UPDATE SET moved_at=excluded.moved_at,operation_id=excluded.operation_id`)
                .run(randomUUID(),row.id,this.workspaceRoot(row.workspace_id),row.current_path,next,row.kind==='directory'?'directory':'file',Date.now(),group.id)
            }
            for (const row of db.prepare('SELECT project_key,anchor_path FROM project_identities WHERE anchor_path IS NOT NULL').all<{project_key:string;anchor_path:string}>()) {
              const move = group.moves.find(item => isInside(item.source,row.anchor_path))
              if (move) db.prepare('UPDATE project_identities SET anchor_path=?,updated_at=? WHERE project_key=?').run(move.target+row.anchor_path.slice(move.source.length),Date.now(),row.project_key)
            }
            this.registry.syncProjection()
            db.prepare("UPDATE object_move_groups SET state='committed' WHERE id=?").run(group.id)
          })
        } catch (error) {
          try { await this.rollbackGroup(group); db.prepare("UPDATE object_move_groups SET state='rolled_back',error=? WHERE id=?").run(String(error),group.id) }
          catch (rollback) { db.prepare("UPDATE object_move_groups SET state='recovery_required',error=? WHERE id=?").run(String(rollback),group.id); throw rollback }
          throw error
        }
      } finally {
        releaseError = await this.releaseGroupTabs(group.id,prepared)
      }
      if (releaseError) throw releaseError
    }
    await locked(0)
  }
  private async releaseGroupTabs(id: string, objects: readonly ObjectRecord[]): Promise<Error | undefined> {
    const transport = getDocumentTabTransport()
    let failure: Error | undefined
    if (transport) for (const row of objects.filter(row => row.kind === 'markdown')) {
      try {
        // The move only locked the tab (no content was applied), so the lease is closed with rollback, not release.
        const reply = await requestDocumentTab(transport, { id: `${id}:${row.id}`, path: row.current_path!, deadline: Date.now()+10000, phase: 'rollback' }, 10000)
        if (!reply.ok) failure = new Error(reply.message)
      } catch (error) { failure = new Error(String(error)) }
    }
    return failure
  }
  private async copyGroupMember(id: string, source: string, target: string): Promise<void> {
    const info = lstatSync(source)
    if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be moved as a page')
    const record = () => { const current = lstatSync(target,{bigint:true}); this.registry.db.prepare('INSERT OR REPLACE INTO object_move_group_locations VALUES (?,?,?,?)').run(id,target,String(current.dev),String(current.ino)) }
    if (info.isDirectory()) {
      await mkdir(target); record()
      for (const name of readdirSync(source)) await this.copyGroupMember(id,join(source,name),join(target,name))
    } else {
      const handle = await open(target,'wx',info.mode)
      try {
        record()
        for await (const chunk of createReadStream(source)) await handle.writeFile(chunk)
        await handle.sync()
        if (fullHash(source) !== fullHash(target)) throw new Error('Move copy readback mismatch')
      } finally { await handle.close() }

    }
  }
  private async writeOwned(id: string, path: string, content: string): Promise<void> {
    const owner = this.registry.db.prepare('SELECT device,inode FROM object_move_group_locations WHERE operation_id=? AND path=?').get<{device:string;inode:string}>(id,path)
    const handle = await open(path,'r+')
    try {
      const actual = await handle.stat({bigint:true})
      if (!owner || owner.device !== String(actual.dev) || owner.inode !== String(actual.ino)) throw new Error('Move target ownership changed')
      await handle.truncate(0); await handle.writeFile(content); await handle.sync()
    } finally { await handle.close() }
  }
  private async rollbackGroup(group: ObjectMoveGroup): Promise<void> {
    if (group.patch && existsSync(group.patch.path)) {
      const move = group.moves.find(item => item.target === group.patch!.path)
      const content = readFileSync(group.patch.path,'utf8')
      if (!move) {
        if (content === group.patch.content) await publishDocumentContent(group.patch.path,group.patch.original)
        else if (content !== group.patch.original) throw new Error('Recovery conflict: renamed content changed')
      } else if (!existsSync(move.source)) {
        if (content === group.patch.content) await this.writeOwned(group.id,group.patch.path,group.patch.original)
        else if (content !== group.patch.original) throw new Error('Recovery conflict: renamed content changed')
      }
    }
    // Both locations can exist when the process exits during a copy. Remove only verified copies.
    const rollback = async (source: string, target: string): Promise<void> => {
      checkedPath(group.sourceRoot ?? group.root,source); checkedPath(group.root,target)
      if (!existsSync(target)) { if (!existsSync(source)) throw new Error('Recovery conflict: both paths missing'); return }
      const owner = this.registry.db.prepare('SELECT device,inode FROM object_move_group_locations WHERE operation_id=? AND path=?').get<{device:string;inode:string}>(group.id,target)
      const actual = lstatSync(target,{bigint:true})
      if (!owner && existsSync(source)) return // A competing creator owns this destination; never delete it.
      if (!owner || owner.device !== String(actual.dev) || owner.inode !== String(actual.ino)) throw new Error('Recovery conflict: target is not owned by this operation')
      if (!existsSync(source) && actual.isDirectory()) await mkdir(source)
      if (!existsSync(source)) {
        const expected = group.objects.find(row => row.current_path === source)
        if (!expected || fullHash(target) !== expected.content_hash) throw new Error('Recovery conflict: moved file changed')
        await this.copyGroupMember(group.id,target,source); await rm(target); return
      }
      const left = lstatSync(source), right = lstatSync(target)
      if (left.isDirectory() && right.isDirectory()) {
        for (const name of readdirSync(target)) await rollback(join(source,name),join(target,name))
        await (await import('node:fs/promises')).rmdir(target)
      } else if (left.isFile() && right.isFile() && (fullHash(source) === fullHash(target) || fullHash(source) === group.objects.find(row => row.current_path === source)?.content_hash)) await rm(target)
      else throw new Error(`Recovery conflict: ${basename(target)} changed`)
    }
    for (const move of [...group.moves].reverse()) await rollback(move.source,move.target)
    validateGroupFiles(group,'source')
  }
  async recoverGroups(): Promise<void> {
    for (const row of this.registry.db.prepare("SELECT id,intent_json FROM object_move_groups WHERE state IN ('prepared','recovery_required')").all<{id:string;intent_json:string}>()) {
      try { await this.rollbackGroup(JSON.parse(row.intent_json)); this.registry.db.prepare("UPDATE object_move_groups SET state='rolled_back',error=NULL WHERE id=?").run(row.id) }
      catch (error) { this.registry.db.prepare("UPDATE object_move_groups SET state='recovery_required',error=? WHERE id=?").run(String(error),row.id); throw error }
    }
  }
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
            const reply=await requestDocumentTab(transport,{id:`${id}:${row.id}`,path,deadline:Date.now()+10000,phase:'rollback'},10000) // lock-only lease
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
    publishObjectMoves(this.registry, objects)
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
