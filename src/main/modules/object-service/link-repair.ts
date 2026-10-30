import { readFileSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { readDocumentSource } from '../../../shared/document-operations'
import { commitDocumentOperation, documentVersion, getDocumentWriteDependencies } from '../document-engine/document-write-service'
import { ObjectRegistry, objectTransaction } from './registry'

type Binding={source_id:string;kind:string;raw_target:string;target_id:string;source_hash:string|null;state:string}
/** Pending bindings remain authoritative even when a source cannot safely be rewritten. */
export async function repairObjectLinks(registry:ObjectRegistry):Promise<void> {
  const dependencies=getDocumentWriteDependencies()
  if(!dependencies)return
  const db=registry.db
  const bindings=db.prepare("SELECT * FROM object_link_targets WHERE state='pending'").all<Binding>()
  for(const sourceId of new Set(bindings.map(row=>row.source_id))) {
    const source=registry.get(sourceId)
    if(source?.kind!=='markdown'||!source.current_path||source.identity_state==='conflict')continue
    const rows=bindings.filter(row=>row.source_id===sourceId)
    try {
      const original=readFileSync(source.current_path,'utf8')
      if(rows.some(row=>row.source_hash!==documentVersion(original)))continue
      const changes=new Map<string,string>()
      for(const row of rows) {
        const target=registry.get(row.target_id)
        if(!target?.current_path||target.identity_state==='conflict')continue
        const next=row.kind==='wikilink' ? basename(target.current_path).replace(/\.md$/i,'')
          : relative(dirname(source.current_path),target.current_path).split('\\').join('/')+(row.raw_target.includes('#')?'#'+row.raw_target.split('#').slice(1).join('#'):'')
        if(next!==row.raw_target)changes.set(row.kind+':'+row.raw_target,row.kind==='mdlink'?encodeURI(next):next)
      }
      if(!changes.size)continue
      const offset=readDocumentSource(original).bodyStart;let fence:string|null=null;let next=original.slice(0,offset)
      for(const line of original.slice(offset).match(/[^\n]*(?:\n|$)/g)??[]) {
        const marker=/^ {0,3}(`{3,}|~{3,})/.exec(line)
        if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;next+=line;continue}
        if(fence){next+=line;continue}
        // Code spans are retained byte-for-byte; links are changed only in prose segments.
        next+=line.replace(/(`+)[\s\S]*?\1|\[\[([^\]\n|#]+)([^\]\n]*)\]\]|(?<!!)\[([^\]\n]+)\]\(([^\s)]+)([^)\n]*)\)/g,(match,code,wiki,suffix,label,url,title)=>{
          if(code)return match
          if(wiki){const value=changes.get('wikilink:'+wiki);return value?`[[${value}${suffix}]]`:match}
          const value=changes.get('mdlink:'+url);return value?`[${label}](${value}${title})`:match
        })
      }
      if(next===original)continue
      const updated=rows.map(row=>({...row,raw_target:changes.get(row.kind+':'+row.raw_target)??row.raw_target,source_hash:documentVersion(next)}))
      const store=(values:Binding[])=>objectTransaction(db,()=>{db.prepare('DELETE FROM object_link_targets WHERE source_id=?').run(sourceId);for(const row of values)db.prepare('INSERT INTO object_link_targets VALUES (?,?,?,?,?,?)').run(row.source_id,row.kind,row.raw_target,row.target_id,row.source_hash,row.state)})
      await commitDocumentOperation({path:source.current_path,expectedVersion:documentVersion(original),operation:{type:'replaceRange',start:0,end:original.length,expectedText:original,replacement:next},origin:'object_link_repair'},dependencies,{
        published:async()=>{store(updated);registry.register(source.current_path!)},
        rollback:async()=>{store(rows);registry.register(source.current_path!)},
        complete:()=>{db.prepare("UPDATE object_link_targets SET state='confirmed' WHERE source_id=?").run(sourceId)},
      })
    } catch(error) {
      // The binding and source version remain pending; callers can still resolve the target by ID.
      console.warn('[objects] link writeback remains pending',sourceId,String(error))
    }
  }
}
