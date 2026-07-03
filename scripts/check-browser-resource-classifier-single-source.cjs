#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SHARED_REL = 'src/shared/browser-tab-resource-classifier.ts'
const RENDERER_DROP_REL = 'src/renderer/components/layout/fileTreeExternalDrop.ts'
const MAIN_ANALYSIS_REL = 'src/main/modules/rss-engine/item-analysis-manager.ts'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function check({ root = ROOT } = {}) {
  const errors = []
  let shared = ''
  let renderer = ''
  let main = ''

  try {
    shared = stripComments(read(root, SHARED_REL))
  } catch (error) {
    errors.push(`missing_shared_classifier:${SHARED_REL}:${error.message}`)
  }
  try {
    renderer = stripComments(read(root, RENDERER_DROP_REL))
  } catch (error) {
    errors.push(`missing_renderer_drop:${RENDERER_DROP_REL}:${error.message}`)
  }
  try {
    main = stripComments(read(root, MAIN_ANALYSIS_REL))
  } catch (error) {
    errors.push(`missing_main_analysis:${MAIN_ANALYSIS_REL}:${error.message}`)
  }

  if (shared && !/\bexport\s+function\s+classifyBrowserTabResource\b/.test(shared)) {
    errors.push(`shared_missing_classifier_export:${SHARED_REL}`)
  }

  if (renderer) {
    if (!/from ['"]\.\.\/\.\.\/\.\.\/shared\/browser-tab-resource-classifier['"]/.test(renderer)) {
      errors.push(`renderer_not_using_shared_classifier:${RENDERER_DROP_REL}`)
    }
    if (/\bVIDEO_DROP_HOST_HINTS\b|\bVIDEO_DROP_EXTS\b/.test(renderer)) {
      errors.push(`renderer_has_local_video_classifier:${RENDERER_DROP_REL}`)
    }
  }

  if (main) {
    if (!/from ['"]\.\.\/\.\.\/\.\.\/shared\/browser-tab-resource-classifier['"]/.test(main)) {
      errors.push(`main_not_using_shared_classifier:${MAIN_ANALYSIS_REL}`)
    }
    if (/\bVIDEO_HOST_HINTS\b|\bVIDEO_EXTS\b/.test(main)) {
      errors.push(`main_has_local_video_classifier:${MAIN_ANALYSIS_REL}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-resource-classifier-single-source] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-resource-classifier-single-source] OK')
}

module.exports = { check }
