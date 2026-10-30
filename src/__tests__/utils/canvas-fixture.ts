import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../../main/modules/migrations'
import { ObjectRegistry } from '../../main/modules/object-service/registry'
import { CanvasService } from '../../main/modules/board-engine/canvas-service'
import type { CanvasNode } from '../../shared/ready-canvas'
export function textNode(id: string): CanvasNode { return { id, type: 'text', text: 'hello world', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'text' } } }
export function canvasFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-canvas-')))
  const db = new Database(join(root, 'test.db')); runMigrations(db)
  db.prepare('INSERT INTO workspaces(root) VALUES (?)').run(root)
  const registry = new ObjectRegistry(db), service = new CanvasService(registry, root)
  return { root, db, registry, service, close() { db.close(); rmSync(root, { recursive: true, force: true }) } }
}
