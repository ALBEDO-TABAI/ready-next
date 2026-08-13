import type { DatabaseConnection } from '../database'

export interface CurrentVisibleTaskProjectionRow {
  taskId: string
  status: string
  title: string | null
  expectedOutputs: string | null
  recentArtifacts: string | null
  updatedAt: string
}

export function listCurrentVisibleTaskProjections(
  db: Pick<DatabaseConnection, 'prepare'>,
  limit: number,
): CurrentVisibleTaskProjectionRow[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  return db.prepare(`
    SELECT task.task_id AS taskId,
           task.status,
           task.task_title AS title,
           task.expected_outputs_json AS expectedOutputs,
           task.recent_artifacts_json AS recentArtifacts,
           task.updated_at AS updatedAt
      FROM task_projections task
      LEFT JOIN chat_conversations scope ON scope.id=task.scope_id
     WHERE task.scope_id IS NULL
        OR (scope.closed_at IS NULL
            AND task.message_visibility_epoch=scope.message_visibility_epoch)
     ORDER BY task.updated_at DESC
     LIMIT ?
  `).all<CurrentVisibleTaskProjectionRow>(boundedLimit)
}
