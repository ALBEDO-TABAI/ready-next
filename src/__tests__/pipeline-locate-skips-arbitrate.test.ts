import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)
const SKELETON_PATH = resolve(
  process.cwd(),
  'src/shared/document-widget-skeletons.ts',
)

describe('NEW-5 回归锁定：pipeline locate 不得调用 arbitrateSkeletonForUserText', () => {
  it('document-task-pipeline-executor.ts 不直接调用 arbitrateSkeletonForUserText', () => {
    const source = readFileSync(EXECUTOR_PATH, 'utf8')
    assert.doesNotMatch(
      source,
      /arbitrateSkeletonForUserText/,
      'pipeline executor 若重新引入 arbitrate 调用，locate/compose 二次执行会重新引入 NEW-5 超时隐患',
    )
  })

  it('arbitrateSkeletonForUserText 仍仅以 export function 形式存在于共享层', () => {
    const source = readFileSync(SKELETON_PATH, 'utf8')
    assert.match(
      source,
      /export function arbitrateSkeletonForUserText\(/,
      'arbitrateSkeletonForUserText 应保持为共享层导出函数（仅测试与渲染降级路径调用）',
    )
  })
})
