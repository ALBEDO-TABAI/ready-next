import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  documentWidgetOpenUIPrompt,
  documentWidgetOpenUISchema,
  listDocumentWidgetCatalog,
} from '../src/shared/document-widget-openui'

const root = process.cwd()
const promptPath = resolve(root, 'docs/DOCUMENT_WIDGET_OPENUI_PROMPT.md')
const schemaPath = resolve(root, 'docs/DOCUMENT_WIDGET_OPENUI_SCHEMA.json')

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

ensureDir(promptPath)
ensureDir(schemaPath)

const catalog = listDocumentWidgetCatalog()

const promptDocument = [
  '# Document Widget OpenUI Prompt',
  '',
  'This file is generated from the Ready document OpenUI component library.',
  '',
  '## Supported Components',
  ...catalog.map((entry) => `- \`${entry.name}\` (${entry.group}, ${entry.sourceType}, ${entry.implementation})`),
  '',
  '## Prompt',
  '',
  '```text',
  documentWidgetOpenUIPrompt.trim(),
  '```',
  '',
].join('\n')

writeFileSync(promptPath, promptDocument, 'utf8')
writeFileSync(schemaPath, JSON.stringify(documentWidgetOpenUISchema, null, 2), 'utf8')

console.log(`Generated ${promptPath}`)
console.log(`Generated ${schemaPath}`)
