import type { DatabaseConnection } from '../database/connection'
import { isAbsolute,relative } from 'path'

import type { DocumentMetadataPort } from './types'

export function createDocumentMetadataPort(rawDb: DatabaseConnection): DocumentMetadataPort {
  return {
    getTitleMetadata(paths,workspaceRoots){
      const allowed=Array.from(new Set(paths.filter((path)=>isPathInsideRoots(path,workspaceRoots)))).slice(0,300);if(!allowed.length)return new Map()
      const placeholders=allowed.map(()=>'?').join(',')
      const rows=rawDb.prepare(`SELECT path,name,frontmatter_json AS frontmatterJson,source_meta_json AS sourceMetaJson FROM documents WHERE path IN (${placeholders})`).all<{path:string;name:string|null;frontmatterJson:string|null;sourceMetaJson:string|null}>(...allowed)
      const out=new Map<string,{path:string;name:string|null;frontmatterTitle:string|null;readyProject:string|null;metadataTitle:string|null;controlledTags:Array<{tagId:string;facet:'form'|'domain'|'entity'|'use'|'state';label:string}>}>()
      for(const row of rows)out.set(row.path,{path:row.path,name:row.name,frontmatterTitle:titleFromJson(row.frontmatterJson),readyProject:projectFromJson(row.frontmatterJson),metadataTitle:titleFromJson(row.sourceMetaJson),controlledTags:[]})
      const assignments=rawDb.prepare(`SELECT f.current_path AS path,a.tag_id AS tagId,a.facet,a.label FROM file_identities f JOIN file_tag_assignments a ON a.file_key=f.file_key WHERE f.current_path IN (${placeholders}) AND a.suppressed=0 AND a.readback_at IS NOT NULL`).all<{path:string;tagId:string;facet:'form'|'domain'|'entity'|'use'|'state';label:string}>(...allowed)
      for(const assignment of assignments)out.get(assignment.path)?.controlledTags.push({tagId:assignment.tagId,facet:assignment.facet,label:assignment.label})
      return out
    },
    findRelatedFiles(tags,workspaceRoots,excludePaths,limit){
      const usable=tags.filter((tag)=>tag.facet==='domain'||tag.facet==='use'||tag.facet==='form');if(!usable.length||!workspaceRoots.length||limit<=0)return[]
      const tagIds=Array.from(new Set(usable.map((tag)=>tag.tagId)));const tagSlots=tagIds.map(()=>'?').join(',');const rootSlots=workspaceRoots.map(()=>'?').join(',')
      const rows=rawDb.prepare(`SELECT f.file_key AS fileKey,f.current_path AS path,a.tag_id AS tagId,a.facet,a.label FROM file_identities f JOIN file_tag_assignments a ON a.file_key=f.file_key WHERE f.workspace_root IN (${rootSlots}) AND a.tag_id IN (${tagSlots}) AND a.suppressed=0 AND a.readback_at IS NOT NULL ORDER BY f.last_seen_at DESC`).all<{fileKey:string;path:string;tagId:string;facet:'form'|'domain'|'entity'|'use'|'state';label:string}>(...workspaceRoots,...tagIds)
      const excluded=new Set(excludePaths);const byFile=new Map<string,{fileKey:string;path:string;name:string;sharedTags:Array<{tagId:string;facet:'form'|'domain'|'entity'|'use'|'state';label:string}>}>()
      for(const row of rows){if(excluded.has(row.path)||!isPathInsideRoots(row.path,workspaceRoots))continue;const item=byFile.get(row.fileKey)??{fileKey:row.fileKey,path:row.path,name:row.path.split(/[\\/]/).pop()||row.path,sharedTags:[]};item.sharedTags.push({tagId:row.tagId,facet:row.facet,label:row.label});byFile.set(row.fileKey,item)}
      return Array.from(byFile.values()).sort((a,b)=>b.sharedTags.length-a.sharedTags.length).slice(0,limit)
    },
  }
}

function projectFromJson(raw:string|null):string|null{const record=parseRecord(raw);if(!record)return null;for(const key of ['ready_project','readyProject']){const value=record[key];if(typeof value==='string'&&value.trim())return value.trim()}return null}
function titleFromJson(raw:string|null):string|null{const record=parseRecord(raw);if(!record)return null;for(const key of ['title','Title','标题','name']){const value=record[key];if(typeof value==='string'&&value.trim())return value.trim()}return null}
function parseRecord(raw:string|null):Record<string,unknown>|null{if(!raw)return null;try{const value=JSON.parse(raw);return value&&typeof value==='object'?value as Record<string,unknown>:null}catch{return null}}
function isPathInsideRoots(path:string,roots:readonly string[]):boolean{if(!isAbsolute(path))return false;return roots.some((root)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))})}
