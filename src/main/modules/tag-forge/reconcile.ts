import type { DatabaseConnection } from '../database'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import { loadTagForgePolicy } from './tag-forge-policy'

type ChangeListener=(workspaceRoot:string)=>void
const listeners=new Set<ChangeListener>()
export function addTagAssignmentChangeListener(listener:ChangeListener):()=>void{listeners.add(listener);return()=>listeners.delete(listener)}

export function reconcileIndexedFrontmatter(db:DatabaseConnection,workspaceRoot:string,path:string,tags:readonly string[]):void{
  if(!path.toLowerCase().endsWith('.md'))return
  const identity=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot,path})
  const repository=new TagForgeRepository(db);const policy=loadTagForgePolicy();const before=JSON.stringify(repository.listAssignments(identity.fileKey))
  repository.reconcileAssignments({fileKey:identity.fileKey,frontmatterTags:tags,knownEntries:[...policy.entries,...repository.listOverlay()]})
  repository.markReadback(identity.fileKey)
  if(before!==JSON.stringify(repository.listAssignments(identity.fileKey)))for(const listener of listeners)listener(workspaceRoot)
}

export function reconcileIndexedWorkspace(db:DatabaseConnection,workspaceRoot:string,workspaceId:number):void{
  const rows=db.prepare(`SELECT path,frontmatter_json AS frontmatter FROM documents WHERE workspace_id=? AND source_type='document'`).all<{path:string;frontmatter:string|null}>(workspaceId)
  for(const row of rows){let tags:string[]=[];try{const parsed=JSON.parse(row.frontmatter||'{}');tags=Array.isArray(parsed.tags)?parsed.tags.map(String):[]}catch{/* malformed is no controlled tags */}reconcileIndexedFrontmatter(db,workspaceRoot,row.path,tags)}
}
