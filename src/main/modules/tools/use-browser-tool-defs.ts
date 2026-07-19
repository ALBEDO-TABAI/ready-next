import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const USE_BROWSER_TOOL_NAME = 'use_browser' as const
export const USE_BROWSER_TOOL_NAMES: readonly string[] = [USE_BROWSER_TOOL_NAME]

const DESCRIPTION = [
  'Activate Ready browser capabilities for the current task.',
  'Use this when the task requires observing or interacting with a web page and browser tools are not yet visible.',
  'This control action does not navigate, click, type, submit, or create a browser task. The activated browser tools become available on the next model iteration.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const

export function getUseBrowserAnthropicTools(): Array<Record<string, unknown>> {
  return [normalizeAnthropicToolSchema({
    name: USE_BROWSER_TOOL_NAME,
    description: DESCRIPTION,
    input_schema: INPUT_SCHEMA,
  })]
}

export function getUseBrowserOpenAITools(): Array<Record<string, unknown>> {
  return [normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: USE_BROWSER_TOOL_NAME,
      description: DESCRIPTION,
      parameters: INPUT_SCHEMA,
    },
  })]
}
