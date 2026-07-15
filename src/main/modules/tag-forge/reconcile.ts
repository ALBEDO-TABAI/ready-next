import type { DatabaseConnection } from '../database'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import { loadTagForgePolicy } from './tag-forge-policy'

type ChangeListener=(workspaceRoot:string)=>void
const listeners=new Set<ChangeListener>()
export function addTagAssignmentChangeListener(listener:ChangeListener):()=>void{listeners.add(listener);return()=>listeners.delete(listener)}

export function reconcileIndexedFrontmatter(db:DatabaseConnection,workspaceRoot:string,path:string,tags:readonly string[],workflowState:string|null=null):void{
  if(!path.toLowerCase().endsWith('.md'))return
  const identity=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot,path})
  const repository=new TagForgeRepository(db);const policy=loadTagForgePolicy();const before=JSON.stringify(repository.listAssignments(identity.fileKey))
  repository.reconcileAssignments({fileKey:identity.fileKey,frontmatterTags:tags,workflowState,knownEntries:[...policy.entries,...repository.listOverlay()]})
  repository.markReadback(identity.fileKey)
  if(before!==JSON.stringify(repository.listAssignments(identity.fileKey)))for(const listener of listeners)listener(workspaceRoot)
}

export function reconcileIndexedWorkspace(db:DatabaseConnection,workspaceRoot:string,workspaceId:number):void{
  const rows=db.prepare(`SELECT path,frontmatter_json AS frontmatter FROM documents WHERE workspace_id=? AND source_type='document'`).all<{path:string;frontmatter:string|null}>(workspaceId)
  for(const row of rows){let tags:string[]=[];let workflowState:string|null=null;try{const parsed=JSON.parse(row.frontmatter||'{}');tags=Array.isArray(parsed.tags)?parsed.tags.map(String):[];workflowState=typeof parsed.ready_state==='string'?parsed.ready_state:null}catch{/* malformed is no controlled tags */}reconcileIndexedFrontmatter(db,workspaceRoot,row.path,tags,workflowState)}
}

export function reconcilePendingIndexedReadbacks(db:DatabaseConnection,workspaceRoot:string,workspaceId:number):void{
  const rows=db.prepare(`SELECT DISTINCT d.path,d.frontmatter_json AS frontmatter FROM documents d JOIN file_identities f ON f.workspace_root=? AND f.current_path=d.path AND f.status='present' JOIN file_tag_assignments a ON a.file_key=f.file_key WHERE d.workspace_id=? AND d.source_type='document' AND LOWER(d.path) LIKE '%.md' AND a.suppressed=0 AND a.readback_at IS NULL`).all<{path:string;frontmatter:string|null}>(workspaceRoot,workspaceId)
  for(const row of rows){let tags:string[]=[];let workflowState:string|null=null;try{const parsed=JSON.parse(row.frontmatter||'{}');tags=Array.isArray(parsed.tags)?parsed.tags.map(String):[];workflowState=typeof parsed.ready_state==='string'?parsed.ready_state:null}catch{/* malformed is no controlled tags */}reconcileIndexedFrontmatter(db,workspaceRoot,row.path,tags,workflowState)}
}
