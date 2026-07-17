export function buildLocalDocumentWriteBudgetCheckpoint(): string {
  return [
    '已经读取源文档，但这轮工具调用次数用完了，目标文档还没有确认写入并保存。',
    '请继续这项任务，我会从已读取的依据接着写入目标文档；不会把原文贴到聊天里。'
  ].join('\n')
}

export function buildToolProgressBudgetCheckpoint(usedTools: string[]): string {
  return [
    '本轮工具调用次数已用完，任务还没完全收口。',
    usedTools.length > 0
      ? `已完成 ${usedTools.length} 次工具操作；请继续这项任务，我会沿着当前进度接着处理。`
      : '请继续这项任务，我会沿着当前进度接着处理。'
  ].join('\n')
}
