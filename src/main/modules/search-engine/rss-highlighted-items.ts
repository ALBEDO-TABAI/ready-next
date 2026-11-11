import { readFile } from 'node:fs/promises'
import type { DatabaseConnection } from '../database/connection'
import { parseReadyUri } from '../../../shared/ready-ref'
import { parseHighlights } from '../library-engine/highlight-markdown'
import { sourceHighlightCodec } from '../library-engine/source-adapters'

/** Source pages own highlights; inspect their current blocks rather than treating an old behavior as an extant mark. */
export async function rssHighlightedItems(db:DatabaseConnection):Promise<Set<string>> {
  const ids=new Set<string>()
  const pages=db.prepare(`SELECT d.object_id AS id,o.current_path AS path,json_extract(d.frontmatter_json,'$.来源引用') AS uri
    FROM documents d JOIN objects o ON o.id=d.object_id WHERE o.status='present' AND o.identity_state<>'conflict'
      AND json_valid(d.frontmatter_json) AND json_extract(d.frontmatter_json,'$.类型')='文章'`).all<{id:string;path:string;uri:string}>()
  for(const page of pages) {
    const parsed=parseReadyUri(page.uri)
    if(!parsed.ok || parsed.ref.kind!=='rss-item') continue
    const ref=parsed.ref
    let raw:string
    try { raw=await readFile(page.path,'utf8') }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') continue;throw error }
    const codec=sourceHighlightCodec({source:{kind:'rss',ref,title:'',author:'',url:'',snapshot:''},text:'',from:0,to:0,reference:()=>ref})
    if(parseHighlights(raw,page.id,codec).some(block=>block.highlight.location.status!=='malformed')) ids.add(ref.id)
  }
  return ids
}
