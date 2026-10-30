import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../../main/modules/migrations'
import { ObjectRegistry } from '../../main/modules/object-service/registry'
import { SearchEngine } from '../../main/modules/search-engine/indexer'
export function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ready-c2-')));const db=new Database(':memory:');runMigrations(db)
  const engine=new SearchEngine(db,{fts5Available:true});engine.getRepository().ensureWorkspace(root)
  const registry=new ObjectRegistry(db)
  return {root,db,engine,registry,close:()=>{engine.cancelPendingWorkspaceResolves();db.close();rmSync(root,{recursive:true,force:true})}}
}
