import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm,realpath,writeFile,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { RssAdapter } from '../main/modules/search-engine/adapters'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SourceDocumentService } from '../main/modules/library-engine/source-documents'
import { rssSource } from '../main/modules/library-engine/source-adapters'
import { rssB10Fixture } from './utils/rss-b10-fixture'

test('starred full text is searchable and disappears on unstar; older saved articles bypass the recent 5000 cap',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t),engine=new SearchEngine(f.db,{fts5Available:true}),repository=engine.getRepository()
  const ctx={repository,workspaceId:repository.ensureWorkspace('@shared'),workspaceRoot:'@shared'},adapter=new RssAdapter()
  f.put('old',f.now-10000000)
  const claim=f.rss.content.beginLoad('old')!
  f.rss.content.finishLoad(claim,{status:'ready',markdown:'uniquefulltextword',sourceUrl:'https://example.test/old'})
  await adapter.reindex(ctx)
  assert.equal((await engine.search('uniquefulltextword',{sources:['rss']})).items.length,0)
  f.rss.toggleRSSStarred('old');await adapter.reindex(ctx)
  assert.equal((await engine.search('uniquefulltextword',{sources:['rss']})).items.length,1)
  f.rss.toggleRSSStarred('old');await adapter.reindex(ctx)
  assert.equal((await engine.search('uniquefulltextword',{sources:['rss']})).items.length,0)
  f.db.prepare(`INSERT INTO rss_items(id,source_id,guid,title,link,published_at)
    SELECT 'new-'||value,?,'new-'||value,'New','https://example.test/new/'||value,? FROM json_each(?)`)
    .run(f.source,f.now/1000,JSON.stringify(Array.from({length:5001},(_,i)=>i)))
  f.rss.toggleRSSStarred('old');await adapter.reindex(ctx)
  assert.equal((await engine.search('uniquefulltextword',{sources:['rss']})).items.length,1)
  f.rss.toggleRSSStarred('old');await adapter.reindex(ctx)
  assert.equal(f.db.prepare("SELECT 1 FROM documents WHERE source_type='rss' AND source_id='old'").get(),undefined)
})
test('real RSS source highlights enable full text; removing all highlight blocks withdraws it',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t),root=await realpath(await mkdtemp(join(tmpdir(),'rss-highlight-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  f.db.prepare('INSERT INTO workspaces(root) VALUES(?)').run(root)
  const engine=new SearchEngine(f.db,{fts5Available:true}),registry=new ObjectRegistry(f.db)
  const writer={index:async(path:string,text:string)=>{const result=await engine.indexDocument(root,path,text);assert.equal(result.ok,true,result.error)}}
  const service=new SourceDocumentService(root,registry,writer),repository=engine.getRepository()
  const ctx={repository,workspaceId:repository.ensureWorkspace('@shared'),workspaceRoot:'@shared'},adapter=new RssAdapter()
  f.put('article');const claim=f.rss.content.beginLoad('article')!
  f.rss.content.finishLoad(claim,{status:'ready',markdown:'highlightneedle otherbodywords',sourceUrl:'https://example.test/article'})
  const article=f.rss.content.getArticle('article')!
  const result=await service.annotate(rssSource(article,{start:{run:0,offset:0},end:{run:0,offset:4}}))
  await adapter.reindex(ctx)
  assert.equal((await engine.search('otherbodywords',{sources:['rss']})).items.length,1)
  // Source page is the authority: deleting blocks must win over historic behavior or cached anchors.
  const content=(await readFile(result.sourcePath,'utf8')).split('## 标注')[0]+'## 标注\n'
  await writeFile(result.sourcePath,content);await writer.index(result.sourcePath,content)
  await adapter.reindex(ctx)
  assert.equal((await engine.search('otherbodywords',{sources:['rss']})).items.length,0)
})
