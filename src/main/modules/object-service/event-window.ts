import { existsSync } from 'node:fs'
import { publishObjectMoves } from './events'
import { queueObjectEvents, releaseObjectEvents } from './pending-events'
import { repairObjectLinks } from './link-repair'
import { ObjectRegistry } from './registry'

/** Both native and chokidar events enter this queue; identity settles before indexing. */
export class ObjectEventWindow {
  private paths=new Set<string>()
  private quiet:ReturnType<typeof setTimeout>|undefined
  private maximum:ReturnType<typeof setTimeout>|undefined
  private pending:Array<{resolve:()=>void;reject:(error:unknown)=>void}>=[]
  private tail:Promise<void>=Promise.resolve()
  private startedAt=0
  private pairing=false
  constructor(private registry:ObjectRegistry,private indexed:(paths:string[],removedPaths:string[])=>Promise<void>) {}
  add(path:string):Promise<void> {
    if(!this.paths.size)this.startedAt=Date.now()
    this.paths.add(path)
    queueObjectEvents(this.registry.db,this)
    // Moves are paired inside one batch. A vanished or not yet registered path may be half of a move, so the batch
    // stays open for its other half; changes to known files settle fast (dated documents reach the calendar in < 1 s).
    if(!this.pairing&&(!existsSync(path)||!this.registry.find(path))){this.pairing=true;clearTimeout(this.maximum);this.maximum=undefined}
    const [quiet,maximum]=this.pairing?[500,2000]:[100,300]
    clearTimeout(this.quiet)
    this.quiet=setTimeout(()=>this.flush(),quiet)
    this.maximum??=setTimeout(()=>this.flush(),Math.max(0,this.startedAt+maximum-Date.now()))
    return new Promise((resolve,reject)=>this.pending.push({resolve,reject}))
  }
  async drain():Promise<void> {this.flush();await this.tail}
  flush():void {
    clearTimeout(this.quiet);clearTimeout(this.maximum);this.maximum=undefined;this.pairing=false
    const paths=[...this.paths];const waiters=this.pending;this.paths.clear();this.pending=[]
    releaseObjectEvents(this.registry.db,this)
    if(!paths.length)return
    const settle=()=>{
      const indexedPaths=()=>this.registry.db.prepare("SELECT path FROM documents WHERE source_type='document'").all<{path:string}>().map(row=>row.path)
      const before=indexedPaths()
      publishObjectMoves(this.registry, this.registry.reconcile(paths))
      const after=new Set(indexedPaths())
      return before.filter(path=>!after.has(path))
    }
    // Identity settles as soon as the batch closes, so a later single-path registration sees the move; indexing still
    // follows the previous batch. Inside an enclosing transaction the batch settles in order after it instead.
    let removed:string[]|null=null,failure:unknown=null
    if(!this.registry.db.inTransaction){try{removed=settle()}catch(error){failure=error}}
    const run=this.tail.then(async()=>{
      if(failure)throw failure
      await this.indexed(paths,removed??settle())
      await repairObjectLinks(this.registry)
    })
    this.tail=run.then(()=>{for(const waiter of waiters)waiter.resolve()},error=>{for(const waiter of waiters)waiter.reject(error)})
  }
}
