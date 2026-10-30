import { after } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseConnection } from '../../main/modules/database/connection'
import { ObjectRegistry } from '../../main/modules/object-service/registry'
import { ObjectMutations } from '../../main/modules/object-service/mutations'
import { FileProjectIdentityRepository } from '../../main/modules/repositories/file-project-identity-repository'
const roots:string[]=[]
after(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true})})
export function newRepositoryFixture():string {const root=realpathSync(mkdtempSync(join(tmpdir(),'ready-object-repo-')));roots.push(root);return root}
export function prepareObjectFixtures(db:DatabaseConnection,workspaces:string[],files:string[]):void {
 for(const root of workspaces){mkdirSync(root,{recursive:true});db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(root)}
 for(const path of files){mkdirSync(dirname(path),{recursive:true});if(!existsSync(path))writeFileSync(path,'fixture\n');new ObjectRegistry(db).register(path)}
}
export function registeredFixtureFile(db:DatabaseConnection,input:{workspaceRoot:string;path:string;observedAt?:number;contentHash?:string|null}) {
 prepareObjectFixtures(db,[input.workspaceRoot],[input.path])
 return new FileProjectIdentityRepository(db).requireFile(input)
}
export async function moveFixture(db:DatabaseConnection,input:{workspaceRoot:string;oldPath:string;newPath:string;kind:string;movedAt?:number}):Promise<void> {
 mkdirSync(dirname(input.newPath),{recursive:true})
 await new ObjectMutations(new ObjectRegistry(db)).move(input.oldPath,input.newPath,{authorizedRoots:[input.workspaceRoot]})
}
/** Explicit database fixture for search-only tests, including intentionally inaccessible roots. */
export function seedSearchObject(db:DatabaseConnection,workspaceId:number,path:string):void {
 db.prepare(`INSERT INTO objects(id,kind,workspace_id,current_path,path_key,last_known_path,status,identity_state,observed_since) VALUES (?,'markdown',?,?,?,?,'present','local',0) ON CONFLICT DO NOTHING`).run('fixture:'+path,workspaceId,path,path,path)
}
