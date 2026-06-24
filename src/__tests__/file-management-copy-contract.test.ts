import assert from 'node:assert/strict'
import test from 'node:test'

import { FILE_MANAGEMENT_SCHEMAS } from '../main/modules/tools/schemas/file-management-schemas'
import { FILE_MANAGEMENT_TOOL_NAMES, getFileManagementOpenAITools } from '../main/modules/tools/file-management-tools'

test('file_copy is exposed as a controlled same-workspace file management tool', () => {
  assert.ok(FILE_MANAGEMENT_TOOL_NAMES.includes('file_copy'))
  assert.ok(FILE_MANAGEMENT_SCHEMAS.file_copy)

  const openAiTool = getFileManagementOpenAITools().find((tool) => (tool as { function?: { name?: string } }).function?.name === 'file_copy') as { function?: { parameters?: { properties?: Record<string, unknown>; required?: string[] } } } | undefined
  assert.ok(openAiTool)
  const parameters = openAiTool.function?.parameters
  assert.deepEqual(parameters?.required, ['path', 'destDir'])
  assert.ok(parameters?.properties?.path)
  assert.ok(parameters?.properties?.destDir)
  assert.ok(parameters?.properties?.newName)
  assert.ok(parameters?.properties?.overwrite)
})


test('file_copy schema keeps overwrite optional so default copy is non-overwriting', () => {
  const overwriteShape = FILE_MANAGEMENT_SCHEMAS.file_copy.shape.overwrite
  assert.ok(overwriteShape.isOptional())
})
