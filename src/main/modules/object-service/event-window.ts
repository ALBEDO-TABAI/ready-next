import { publishObjectMoves } from './events'
import { repairObjectLinks } from './link-repair'
import { ObjectRegistry } from './registry'

/** Both native and chokidar events enter this queue; identity settles before indexing. */
export class ObjectEventWindow {
  private paths=new Set<string>()
  private quiet:ReturnType<typeof setTimeout>|undefined
  private maximum:ReturnType<typeof setTimeout>|undefined
  private pending:Array<{resolve:()=>void;reject:(error:unknown)=>void}>=[]
  private tail:Promise<void>=Promise.resolve()
  constructor(private registry:ObjectRegistry,private indexed:(paths:string[],removedPaths:string[])=>Promise<void>) {}
  add(path:string):Promise<void> {
    this.paths.add(path)
    clearTimeout(this.quiet)
    this.quiet=setTimeout(()=>this.flush(),100)
    this.maximum??=setTimeout(()=>this.flush(),300)
    return new Promise((resolve,reject)=>this.pending.push({resolve,reject}))
  }
  async drain():Promise<void> {this.flush();await this.tail}
  flush():void {
    clearTimeout(this.quiet);clearTimeout(this.maximum);this.maximum=undefined
    const paths=[...this.paths];const waiters=this.pending;this.paths.clear();this.pending=[]
    if(!paths.length)return
    const run=this.tail.then(async()=>{
      const indexedPaths=()=>this.registry.db.prepare("SELECT path FROM documents WHERE source_type='document'").all<{path:string}>().map(row=>row.path)
      const before=indexedPaths()
      const objectsBefore = this.registry.list()
      this.registry.reconcile(paths)
      publishObjectMoves(this.registry, objectsBefore)
      const after=new Set(indexedPaths())
      await this.indexed(paths,before.filter(path=>!after.has(path)))
      await repairObjectLinks(this.registry)
    })
    this.tail=run.then(()=>{for(const waiter of waiters)waiter.resolve()},error=>{for(const waiter of waiters)waiter.reject(error)})
  }
}
