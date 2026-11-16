import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { DatabaseConnection } from '../database/connection'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import { readDocumentSource } from '../../../shared/document-operations'
import { objectKind } from './schema'
import { settleQueuedObjectEvents } from './pending-events'
import { publishObjectMoves } from './events'

export interface ObjectRecord {
  id: string
  kind: 'markdown' | 'canvas' | 'file' | 'directory'
  workspace_id: number | null
  current_path: string | null
  path_key: string | null
  last_known_path: string
  status: 'unverified' | 'present' | 'missing' | 'trashed' | 'deleted'
  identity_state: 'local' | 'portable' | 'conflict'
  embedded_ready_id: string | null
  device: string | null
  inode: string | null
  birthtime_ns: string | null
  size: number | null
  mtime_ns: string | null
  content_hash: string | null
  revision: number
  observed_since: number
  last_verified_at: number | null
}
interface Observation {
  path: string; kind: ObjectRecord['kind']; device: string; inode: string; birth: string
  size: number; mtime: string; hash: string | null; embedded: string | null; links: number
}
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
}
export function canonicalObjectPath(path:string):string {
  try {return realpathSync.native(path)} catch(error) {
    if(!(error && typeof error==='object' && 'code' in error && (error.code==='ENOENT'||error.code==='ENOTDIR')))throw error
    const parent=dirname(path)
    return parent===path ? path : join(canonicalObjectPath(parent),basename(path))
  }
}
export function fullHash(path: string): string {
  const fd = openSync(path, 'r'); const hash = createHash('sha256'); const buffer = Buffer.alloc(128 * 1024)
  try { let n: number; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0,n)) } finally { closeSync(fd) }
  return hash.digest('hex')
}
/** Directories a walk never descends into: version control, dependencies and caches hold nothing a person files. */
const WALK_SKIPPED_NAMES: ReadonlySet<string> = new Set(['.ready', '.git', '.hg', '.svn', 'node_modules', '__pycache__', '.pytest_cache', '.tox', '.venv', 'venv', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.gradle'])
/** A walk also stays out of a directory that marks itself as a cache (CACHEDIR.TAG: Rust's `target`, and others). */
function walkSkips(dir: string, name: string): boolean {
  return WALK_SKIPPED_NAMES.has(name) || existsSync(join(dir, name, 'CACHEDIR.TAG'))
}
/** Whether the file at a row's path is still the one last verified: same file (device, inode), same size and write time. */
function sameAsVerified(row: ObjectRecord, kind: ObjectRecord['kind'], stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): boolean {
  return row.kind === kind && row.device === String(stat.dev) && row.inode === String(stat.ino) && row.mtime_ns === String(stat.mtimeNs)
    && (kind === 'directory' || (row.size === Number(stat.size) && row.content_hash !== null))
}
type Statement = ReturnType<DatabaseConnection['prepare']>
const statements = new WeakMap<DatabaseConnection, Map<string, Statement>>()
/** `known`: the row already at this path. Unchanged since it was verified, its hash and embedded id are kept, not read again. */
function observe(path: string, known?: (canonical: string) => ObjectRecord | undefined): Observation | null {
  try {
    const canonical = realpathSync.native(path)
    const stat = statSync(canonical, { bigint: true })
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Unsupported object file type')
    const kind = stat.isDirectory() ? 'directory' : objectKind(canonical)
    const row = known?.(canonical)
    if (row && row.status === 'present' && row.identity_state !== 'conflict' && sameAsVerified(row, kind, stat)) {
      return {path:canonical,kind,device:String(stat.dev),inode:String(stat.ino),birth:String(stat.birthtimeNs),size:Number(stat.size),mtime:String(stat.mtimeNs),hash:row.content_hash,embedded:row.embedded_ready_id,links:Number(stat.nlink)}
    }
    let embedded: unknown = null
    if (kind === 'markdown' || kind === 'canvas') {
      const raw = readFileSync(canonical, 'utf8')
      // Invalid frontmatter/JSON is still a local file; the write service reports its parse failure.
      try {
        if (kind === 'markdown') embedded = readDocumentSource(raw).frontmatter.ready_id ?? null
        else { const json: unknown = JSON.parse(raw); if (json && typeof json === 'object' && 'ready' in json && json.ready && typeof json.ready === 'object' && 'id' in json.ready) embedded = json.ready.id }
      } catch { embedded = null }
    }
    const valid = typeof embedded === 'string' && ReadyRefSchema.safeParse({kind:'file',id:embedded}).success
    const hash = kind === 'directory' ? null : fullHash(canonical)
    const after = statSync(canonical, { bigint: true })
    if (after.ino !== stat.ino || after.mtimeNs !== stat.mtimeNs || after.size !== stat.size) throw new Error('Object changed during verification')
    return {path:canonical,kind,device:String(stat.dev),inode:String(stat.ino),birth:String(stat.birthtimeNs),size:Number(stat.size),mtime:String(stat.mtimeNs),hash,embedded:valid ? String(embedded) : null,links:Number(stat.nlink)}
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}
export function objectTransaction<T>(db:DatabaseConnection, work:()=>T):T {
  db.exec('SAVEPOINT object_change')
  try { const value = work(); db.exec('RELEASE object_change'); return value } catch(error) { db.exec('ROLLBACK TO object_change; RELEASE object_change'); throw error }
}
/** Publishes the moves among these rows now, or once an enclosing transaction has settled (none if it rolled back). */
function announceMoves(registry:ObjectRegistry,before:readonly ObjectRecord[]):void {
  if(!before.length)return
  if(!registry.db.inTransaction){publishObjectMoves(registry,before);return}
  let tries=0
  const later=()=>{
    // A connection closed meanwhile (shutdown, a finished test) has nothing left to announce.
    if((registry.db as {open?:boolean}).open===false)return
    if(!registry.db.inTransaction)publishObjectMoves(registry,before); else if(++tries<100)setImmediate(later)
  }
  setImmediate(later)
}
export class ObjectRegistry {
  constructor(readonly db: DatabaseConnection) {}
  /** One compiled statement per SQL text for the life of the connection: a pass over many rows prepares nothing twice. */
  private sql(text:string):Statement {
    let cache=statements.get(this.db)
    if(!cache){cache=new Map();statements.set(this.db,cache)}
    let statement=cache.get(text)
    if(!statement){statement=this.db.prepare(text);cache.set(text,statement)}
    return statement
  }
  get(id:string):ObjectRecord|null { return this.sql('SELECT * FROM objects WHERE id=?').get<ObjectRecord>(id) ?? null }
  find(path:string):ObjectRecord|null {
    let canonical = path
    try { canonical = realpathSync.native(path) } catch(error) { if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error }
    return this.sql("SELECT * FROM objects WHERE path_key=? AND status='present'").get<ObjectRecord>(canonical) ?? null
  }
  /** The object at this path when its file is unchanged since it was last verified; nothing is read or written. */
  private verified(path:string):ObjectRecord|null {
    try {
      const canonical=realpathSync.native(path), stat=statSync(canonical,{bigint:true})
      if(!stat.isFile() && !stat.isDirectory())return null
      const row=this.sql("SELECT * FROM objects WHERE path_key=? AND status='present'").get<ObjectRecord>(canonical)
      return row && row.identity_state!=='conflict' && sameAsVerified(row,stat.isDirectory()?'directory':objectKind(canonical),stat) ? row : null
    } catch(error) {
      if(error && typeof error==='object' && 'code' in error && (error.code==='ENOENT'||error.code==='ENOTDIR'))return null
      throw error
    }
  }
  workspace(path:string):number|null { return this.workspaces()(path) }
  /** The workspace of a path, with the roots read and resolved once for a whole pass. */
  private workspaces():(path:string)=>number|null {
    const roots = this.sql('SELECT id,root FROM workspaces ORDER BY length(root) DESC').all<{id:number;root:string}>()
      .filter(row => isAbsolute(row.root)).map(row => ({ id: row.id, root: canonicalObjectPath(row.root) }))
    return path => { const canonical = canonicalObjectPath(path); return roots.find(row => isInside(row.root,canonical))?.id ?? null }
  }
  list():ObjectRecord[] { return this.db.prepare('SELECT * FROM objects').all<ObjectRecord>() }
  /** Registration is owned here; callers never mint IDs or assert existence from an event. */
  register(path:string):ObjectRecord {
    if (!isAbsolute(path)) throw new Error('Object path must be absolute')
    settleQueuedObjectEvents(this.db)
    // Asking for an object that is already known and unchanged costs one lookup and one stat. Otherwise this path
    // alone is settled: naming a folder identifies the folder, it does not read everything under it.
    const known = this.verified(path)
    if (known) return known
    this.reconcile([path], false)
    const object = this.find(path)
    if (!object) throw new Error(`Object is not present: ${path}`)
    return object
  }
  reserve(path:string):ObjectRecord {
    const observation=observe(path)
    if(observation)return this.register(path)
    const canonical=canonicalObjectPath(path)
    const existing=this.db.prepare("SELECT * FROM objects WHERE last_known_path=? AND status='unverified'").get<ObjectRecord>(canonical)
    if(existing)return existing
    const id=randomUUID()
    this.db.prepare("INSERT INTO objects(id,kind,workspace_id,last_known_path,status,identity_state,observed_since) VALUES (?,?,?,?,'unverified','local',?)").run(id,objectKind(path),this.workspace(path),canonical,Date.now())
    return this.get(id)!
  }
  scan(root:string, ignored:ReadonlySet<string> = new Set()):void {
    const paths:string[]=[]
    const walk=(dir:string)=>{ for(const entry of readdirSync(dir,{withFileTypes:true})) {
      if(entry.name === '.ready' || ignored.has(entry.name) || entry.isSymbolicLink()) continue
      const path=join(dir,entry.name); paths.push(path); if(entry.isDirectory()) walk(path)
    }}
    walk(root)
    // Recorded paths are canonical already; only the root is resolved.
    const canonicalRoot=canonicalObjectPath(root)
    this.reconcile([...paths,...this.list().filter(row=>isInside(canonicalRoot,row.current_path??row.last_known_path)).map(row=>row.current_path??row.last_known_path)],false)
  }
  /** One complete event window; releases locations before assignment to support path swaps. */
  reconcile(paths:readonly string[],expandDirectories=true):ObjectRecord[] {
    paths=paths.map(canonicalObjectPath).filter(path => !path.split(/[\\/]/).includes('.ready'))
    const before=this.list().filter(row => row.status !== 'trashed' && row.status !== 'deleted')
    const expanded=new Set(paths)
    const at=(row:ObjectRecord)=>row.current_path??row.last_known_path
    // Every known object at or under a named path belongs to the window: one walk up each row's ancestors instead of
    // comparing every row with every path.
    const named=new Set(paths)
    for(const row of before) for(let path=at(row);;) {
      if(named.has(path)){expanded.add(at(row));break}
      const parent=dirname(path); if(parent===path)break; path=parent
    }
    for(const path of paths) {
      const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})) {if(entry.isSymbolicLink() || walkSkips(dir,entry.name))continue;const child=join(dir,entry.name);expanded.add(child);if(entry.isDirectory())walk(child)}}
      try { if(expandDirectories && lstatSync(path).isDirectory()) walk(path) } catch(error) { if(!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT')) throw error }
    }
    // A durable group owns these locations until all its members commit or roll back.
    if (this.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='object_move_groups'").get()) {
      const pending = this.db.prepare("SELECT intent_json FROM object_move_groups WHERE state IN ('prepared','recovery_required')").all<{intent_json:string}>()
      const moves = pending.flatMap(row => { const intent: { moves: Array<{source:string;target:string}>; objects: ObjectRecord[] } = JSON.parse(row.intent_json); return [...intent.moves, ...intent.objects.map(object => ({source: object.current_path!,target: object.current_path!}))] })
      if (moves.length) for (const path of expanded) if (moves.some(move => isInside(move.source,path) || isInside(move.target,path))) expanded.delete(path)
    }
    const observed=new Map<string,Observation>()
    const missing=new Set<string>()
    const presentAt=new Map<string,ObjectRecord>(); const beforeAt=new Map<string,ObjectRecord[]>(); const beforeById=new Map<string,ObjectRecord>()
    for(const row of before) {
      if(row.status==='present')presentAt.set(row.current_path!,row)
      beforeAt.set(at(row),[...(beforeAt.get(at(row))??[]),row]); beforeById.set(row.id,row)
    }
    for(const path of expanded) {const item=observe(path,canonical=>presentAt.get(canonical));if(item)observed.set(item.path,item);else missing.add(path)}
    // A file seen where no object lives, whose device, inode and birth time match an object whose recorded path has
    // vanished, is that object moved: the pass that sees the new path first pairs them, whether it is a watcher batch
    // or a single-path registration that ran before the watcher noticed the move.
    for(const item of observed.values()) {
      if(item.links!==1 || item.inode==='0' || !item.birth || item.birth==='0' || beforeAt.has(item.path))continue
      for(const row of this.sql("SELECT * FROM objects WHERE device=? AND inode=? AND birthtime_ns=? AND status IN ('present','missing')").all<ObjectRecord>(item.device,item.inode,item.birth)) {
        const place=at(row)
        if(!observed.has(place) && !existsSync(place)) {missing.add(place);expanded.add(place)}
      }
    }
    const old=before.filter(row => expanded.has(at(row)) || observed.has(at(row)))
    const oldAt=new Map<string,ObjectRecord[]>()
    for(const row of old) oldAt.set(at(row),[...(oldAt.get(at(row))??[]),row])
    const assigned=new Map<string,{item:Observation;id:string;conflict:boolean}>()
    const used=new Set<string>()
    const duplicates=new Map<string,Observation[]>()
    for(const item of observed.values()) if(item.embedded) duplicates.set(item.embedded,[...(duplicates.get(item.embedded)??[]),item])
    const compatible=(row:ObjectRecord,item:Observation)=>!item.embedded || item.embedded===row.id
    const ownerStillPresent=(id:string)=>{const owner=beforeById.get(id);return owner?.status==='present' && owner.current_path && !missing.has(owner.current_path) && (!observed.has(owner.current_path) || observed.get(owner.current_path)?.embedded===id)}
    // Same-location saves retain identity even when the publisher replaces the inode.
    for(const item of observed.values()) {
      const row=oldAt.get(item.path)?.find(row=>row.status==='present'||row.status==='unverified')
      if(row && (compatible(row,item) || (row.identity_state==='conflict' && row.embedded_ready_id===item.embedded))) {assigned.set(item.path,{item,id:row.id,conflict:row.identity_state==='conflict'});used.add(row.id)}
    }
    // Candidates are looked up, not searched for: old rows and observations are grouped by the key each phase compares
    // (file identity, content, embedded id), so a pass over N files does not compare each with every known object.
    const availableRow=(row:ObjectRecord)=>!used.has(row.id) && row.status!=='deleted' && (missing.has(at(row)) || observed.has(at(row)))
    const group=<T,>(items:Iterable<T>,key:(item:T)=>string|null)=>{const groups=new Map<string,T[]>();for(const item of items){const k=key(item);if(k!==null)groups.set(k,[...(groups.get(k)??[]),item])}return groups}
    const rowKeys={
      inode:(row:ObjectRecord)=>row.device===null||row.inode===null||row.birthtime_ns===null?null:`${row.device}|${row.inode}|${row.birthtime_ns}`,
      hash:(row:ObjectRecord)=>row.content_hash===null?null:`${row.content_hash}|${row.size}`,
      embedded:(row:ObjectRecord)=>row.id,
    }
    const itemKeys={
      inode:(item:Observation)=>`${item.device}|${item.inode}|${item.birth}`,
      hash:(item:Observation)=>item.hash===null?null:`${item.hash}|${item.size}`,
      embedded:(item:Observation)=>item.embedded,
    }
    for(const phase of ['inode','hash','embedded'] as const) {
      const rows=group(old,rowKeys[phase]), items=group(observed.values(),itemKeys[phase])
      for(const item of observed.values()) {
        if(assigned.has(item.path))continue
        if(phase==='inode' && (item.links!==1 || item.inode==='0'))continue
        const key=itemKeys[phase](item)
        if(key===null)continue
        // A missing object comes back only on full file identity (inode and a real birth time), never on equal content.
        const candidates=(rows.get(key)??[]).filter(row=>availableRow(row) && (phase==='embedded'||row.status==='present'||(phase==='inode'&&row.status==='missing'&&!!row.birthtime_ns&&row.birthtime_ns!=='0')) && compatible(row,item))
        if(candidates.length!==1)continue
        const row=candidates[0]
        const competing=(items.get(key)??[]).filter(other=>!assigned.has(other.path)&&compatible(row,other)&&(phase!=='inode'||other.links===1))
        if(competing.length!==1)continue
        assigned.set(item.path,{item,id:row.id,conflict:false});used.add(row.id)
      }
    }
    for(const item of observed.values()) {
      if(assigned.has(item.path))continue
      const duplicate=!!item.embedded && ((duplicates.get(item.embedded)?.length??0)>1 || !!ownerStillPresent(item.embedded) || used.has(item.embedded) || ['trashed','deleted'].includes(this.get(item.embedded)?.status ?? ''))
      const replacement=!!item.embedded && !!oldAt.get(item.path)?.some(row=>row.status==='present' && row.id!==item.embedded) && !beforeById.has(item.embedded)
      const id=item.embedded && !duplicate && !replacement ? item.embedded : randomUUID()
      assigned.set(item.path,{item,id,conflict:duplicate||replacement});used.add(id)
    }
    const workspaceOf=this.workspaces()
    objectTransaction(this.db,()=>{
      this.captureLinks()
      for(const row of old) if(row.status==='present' && (missing.has(row.current_path!) || observed.has(row.current_path!))) {
        this.sql("UPDATE objects SET current_path=NULL,path_key=NULL,status='missing' WHERE id=?").run(row.id)
      }
      for(const {item,id,conflict} of assigned.values()) {
        const existing=this.get(id)
        if(existing && existing.current_path!==item.path)this.sql("UPDATE object_link_repairs SET state='pending' WHERE source_id=? OR target_id=?").run(id,id)
        // An existing local UUID conflicting with an embedded claim must never be silently renumbered.
        const displaced=oldAt.get(item.path)?.find(row=>row.id!==id && row.status==='unverified')
        const actualId=displaced ? displaced.id : id
        const state=conflict || !!displaced ? 'conflict' : item.embedded ? 'portable' : 'local'
        this.sql(`INSERT INTO objects(id,kind,workspace_id,current_path,path_key,last_known_path,status,embedded_ready_id,identity_state,device,inode,birthtime_ns,size,mtime_ns,content_hash,observed_since,last_verified_at)
          VALUES (?,?,?,?,?,?,'present',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind,workspace_id=excluded.workspace_id,current_path=excluded.current_path,path_key=excluded.path_key,last_known_path=excluded.last_known_path,
          status='present',embedded_ready_id=excluded.embedded_ready_id,identity_state=excluded.identity_state,device=excluded.device,inode=excluded.inode,
          birthtime_ns=excluded.birthtime_ns,size=excluded.size,mtime_ns=excluded.mtime_ns,content_hash=excluded.content_hash,last_verified_at=excluded.last_verified_at,revision=objects.revision+1`)
          .run(actualId,item.kind,workspaceOf(item.path),item.path,item.path,item.path,item.embedded,state,item.device,item.inode,item.birth,item.size,item.mtime,item.hash,existing?.observed_since??Date.now(),Date.now())
      }
      for(const row of old) if(missing.has(at(row)) && !used.has(row.id) && row.status!=='deleted') {
        this.sql("UPDATE objects SET current_path=NULL,path_key=NULL,status='missing',last_verified_at=?,revision=revision+1 WHERE id=?").run(Date.now(),row.id)
      }
      this.syncProjection()
    })
    // Whichever pass completes a move (watcher batch, registration, page tree) announces it, so open tabs follow.
    announceMoves(this,old)
    return old
  }
  captureLinks():void {
    this.db.exec(`UPDATE object_link_repairs SET source_hash=(SELECT content_hash FROM objects WHERE id=source_id) WHERE state='confirmed'`)
  }
  syncProjection():void {
    // Free projection paths before swaps, while preserving row IDs and incoming links.
    this.db.exec(`UPDATE documents SET path='object-location:'||object_id WHERE object_id IN (SELECT id FROM objects WHERE status='present') AND path<>(SELECT current_path FROM objects WHERE id=object_id);
      DELETE FROM documents WHERE object_id IN (SELECT id FROM objects WHERE status<>'present' OR identity_state='conflict');
      UPDATE documents SET path=(SELECT current_path FROM objects WHERE id=object_id),workspace_id=COALESCE((SELECT workspace_id FROM objects WHERE id=object_id),workspace_id) WHERE object_id IN (SELECT id FROM objects WHERE status='present');`)
  }
  markDeleted(path:string):void {
    objectTransaction(this.db,()=>{this.captureLinks();for(const row of this.list()) if(row.current_path && isInside(path,row.current_path)) this.db.prepare("UPDATE objects SET status='deleted',current_path=NULL,path_key=NULL,revision=revision+1,last_verified_at=? WHERE id=?").run(Date.now(),row.id);this.syncProjection()})
  }
}
