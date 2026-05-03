#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_SCORE_KEYS = [
  'aesthetic_beauty',
  'credibility',
  'impact',
  'memorability',
  'fun_interest',
]

const REQUIRED_STORYBOARD_KEYS = [
  'shot_size',
  'lighting',
  'camera_movement',
  'visual_style',
  'technique',
]

const REQUIRED_TEXT_KEYS = [
  'type_classification',
  'description',
  'selection_reasoning',
  'edit_suggestion',
]

const REQUIRED_OUTPUT_KEYS = [
  'storyboard_md',
  'storyboard_pdf',
  'audiovisual_md',
  'audiovisual_pdf',
]

const VIDEO_ARTIFACT_SUFFIXES = [
  'storyboard',
  'storyboard_context',
  'audiovisual_analysis',
  'detailed_analysis',
  'complete_analysis',
  'classification_summary',
]

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonEmptyText(value) {
  const text = stringValue(value)
  return text.length > 0 && !/^TODO\b/i.test(text)
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file)
    return {
      path: file,
      exists: stat.isFile(),
      size: stat.isFile() ? stat.size : 0,
      ok: stat.isFile() && stat.size > 0,
    }
  } catch {
    return {
      path: file,
      exists: false,
      size: 0,
      ok: false,
    }
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function missingSceneFields(scene) {
  const rec = objectValue(scene)
  if (!rec) return ['scene']

  const missing = []
  const scores = objectValue(rec.scores)
  for (const key of REQUIRED_SCORE_KEYS) {
    if (!scores || (numberValue(scores[key]) || 0) <= 0) missing.push(`scores.${key}`)
  }

  const storyboard = objectValue(rec.storyboard)
  for (const key of REQUIRED_STORYBOARD_KEYS) {
    if (!storyboard || !nonEmptyText(storyboard[key])) missing.push(`storyboard.${key}`)
  }

  for (const key of REQUIRED_TEXT_KEYS) {
    if (!nonEmptyText(rec[key])) missing.push(key)
  }
  if ((numberValue(rec.weighted_score) || 0) <= 0) missing.push('weighted_score')
  if (!stringValue(rec.selection).startsWith('[')) missing.push('selection')
  return missing
}

function inspectHostBatches(outputDir, problems) {
  const hostDir = path.join(outputDir, 'host_batches')
  const indexPath = path.join(hostDir, 'index.json')
  const index = readJson(indexPath)
  const batches = asArray(objectValue(index)?.batches)
  const summary = {
    total: batches.length,
    completed: 0,
    blocked: 0,
    pending: 0,
    inProgress: 0,
    missingOutputs: 0,
  }

  if (!index) {
    problems.push('host_batches/index.json missing or invalid')
    return summary
  }
  if (batches.length === 0) {
    problems.push('host_batches has no batches')
    return summary
  }

  const coverage = numberValue(index.coverage_ratio)
  if (coverage !== null && coverage < 1) {
    problems.push(`host_batches coverage_ratio ${coverage}`)
  }

  for (const batch of batches) {
    const rec = objectValue(batch) || {}
    const batchId = stringValue(rec.batch_id) || '(unknown batch)'
    const outputName = stringValue(rec.output)
    const outputPath = outputName ? path.join(hostDir, outputName) : ''
    const payload = outputPath ? readJson(outputPath) : null
    const receipt = objectValue(objectValue(payload)?.receipt)
    const status = stringValue(receipt?.status || rec.status).toLowerCase()

    if (!outputName || !payload) {
      summary.missingOutputs += 1
      problems.push(`host batch ${batchId} output missing`)
      continue
    }
    if (status === 'completed') summary.completed += 1
    else if (status === 'blocked') summary.blocked += 1
    else if (status === 'in_progress') summary.inProgress += 1
    else summary.pending += 1

    if (status !== 'completed') {
      problems.push(`host batch ${batchId} status=${status || '(missing)'}`)
    }
  }

  return summary
}

function outputPathFromDelivery(delivery, key, outputDir, videoId) {
  const fallbackName = key === 'storyboard_md'
    ? `${videoId}_storyboard.md`
    : key === 'storyboard_pdf'
      ? `${videoId}_storyboard.pdf`
      : key === 'audiovisual_md'
        ? `${videoId}_audiovisual_analysis.md`
        : `${videoId}_audiovisual_analysis.pdf`
  const fallback = path.join(outputDir, fallbackName)
  const required = objectValue(delivery?.required_outputs)
  const entry = required ? required[key] : null
  if (typeof entry === 'string' && entry.trim()) return path.resolve(outputDir, entry)
  const entryPath = stringValue(objectValue(entry)?.path)
  return entryPath ? path.resolve(outputDir, entryPath) : fallback
}

function inspectDelivery(delivery, problems) {
  const status = stringValue(delivery?.status).toLowerCase()
  if (status !== 'completed') problems.push(`delivery_report status=${status || '(missing)'}`)

  const blockedFields = [
    'missing_outputs',
    'blocked_batches',
    'incomplete_scene_numbers',
    'missing_screenshot_scenes',
    'missing_sample_scenes',
    'blockers',
  ]
  for (const field of blockedFields) {
    const value = delivery?.[field]
    if (Array.isArray(value) && value.length > 0) {
      problems.push(`delivery_report ${field} not empty`)
    }
  }
  if (nonEmptyText(delivery?.last_error)) problems.push('delivery_report last_error not empty')

  const required = objectValue(delivery?.required_outputs)
  if (!required) {
    problems.push('delivery_report required_outputs missing')
    return
  }
  for (const [key, value] of Object.entries(required)) {
    const entry = objectValue(value)
    if (entry && entry.ok === false) problems.push(`delivery_report required_outputs.${key} not ok`)
  }
}

function findMixedVideoArtifacts(outputDir, videoId) {
  const mixed = []
  const suffixPattern = VIDEO_ARTIFACT_SUFFIXES.map((suffix) => suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const artifactPattern = new RegExp(`^(.+)_(${suffixPattern})\\.(md|pdf|json)$`)
  let entries = []
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true })
  } catch {
    return mixed
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = entry.name.match(artifactPattern)
    if (!match) continue
    const prefix = match[1]
    if (prefix !== videoId) mixed.push(entry.name)
  }
  return mixed
}

function inspectVeaArtifacts(outputDirInput) {
  const outputDir = path.resolve(outputDirInput)
  const problems = []
  const runState = readJson(path.join(outputDir, 'run_state.json'))
  const scores = readJson(path.join(outputDir, 'scene_scores.json'))
  const delivery = readJson(path.join(outputDir, 'delivery_report.json'))
  const scenes = asArray(objectValue(scores)?.scenes)
  const videoId = stringValue(objectValue(scores)?.video_id)
    || stringValue(objectValue(delivery)?.video_id)
    || path.basename(outputDir)

  const runStatus = stringValue(objectValue(runState)?.status).toLowerCase()
  if (runStatus !== 'completed') problems.push(`run_state status=${runStatus || '(missing)'}`)

  const totalScenes = scenes.length
  let completeScenes = 0
  const incompleteScenes = []
  if (totalScenes === 0) problems.push('scene_scores has no scenes')
  for (const scene of scenes) {
    const missing = missingSceneFields(scene)
    if (missing.length === 0) {
      completeScenes += 1
      continue
    }
    const sceneNumber = numberValue(objectValue(scene)?.scene_number) || incompleteScenes.length + 1
    incompleteScenes.push({ sceneNumber, missing })
    for (const field of missing) problems.push(`scene ${sceneNumber} missing ${field}`)
  }

  const expectedTotal = numberValue(objectValue(runState)?.total_scenes)
  const expectedCompleted = numberValue(objectValue(runState)?.completed_scenes)
  if (expectedTotal !== null && expectedTotal !== totalScenes) {
    problems.push(`run_state total_scenes=${expectedTotal} but scene_scores has ${totalScenes}`)
  }
  if (expectedCompleted !== null && expectedCompleted !== totalScenes) {
    problems.push(`run_state completed_scenes=${expectedCompleted} but scene_scores has ${totalScenes}`)
  }

  const hostBatches = inspectHostBatches(outputDir, problems)
  inspectDelivery(objectValue(delivery), problems)

  const requiredOutputs = {}
  for (const key of REQUIRED_OUTPUT_KEYS) {
    const info = fileInfo(outputPathFromDelivery(objectValue(delivery), key, outputDir, videoId))
    requiredOutputs[key] = info
    if (!info.ok) problems.push(`required output ${key} missing or empty`)
  }

  for (const file of findMixedVideoArtifacts(outputDir, videoId)) {
    problems.push(`mixed video artifact ${file}`)
  }

  return {
    ok: problems.length === 0,
    outputDir,
    problems,
    summary: {
      videoId,
      runStateStatus: runStatus || null,
      runStateStage: stringValue(objectValue(runState)?.current_stage || objectValue(runState)?.currentStage) || null,
      deliveryStatus: stringValue(objectValue(delivery)?.status).toLowerCase() || null,
      totalScenes,
      completeScenes,
      incompleteScenes,
      hostBatches,
      requiredOutputs,
    },
  }
}

function parseArgs(argv) {
  const opts = {
    outputDir: '',
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--output-dir') {
      opts.outputDir = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--run-state') {
      const runStatePath = argv[index + 1] || ''
      opts.outputDir = path.dirname(runStatePath)
      index += 1
      continue
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
  }
  return opts
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/vea-assert-artifacts.cjs --output-dir /abs/vea-output [--json]',
    '  node scripts/vea-assert-artifacts.cjs --run-state /abs/vea-output/run_state.json [--json]',
    '',
    'Checks completed VEA artifacts without starting models or modifying handoff files.',
  ].join('\n'))
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }
  if (!opts.outputDir) throw new Error('Missing --output-dir or --run-state')
  const report = inspectVeaArtifacts(opts.outputDir)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (report.ok) {
    process.stdout.write(`VEA artifacts: ok (${report.summary.completeScenes}/${report.summary.totalScenes} scenes)\n`)
  } else {
    process.stdout.write(`VEA artifacts: failed\n${report.problems.map((problem) => `- ${problem}`).join('\n')}\n`)
  }
  return report.ok ? 0 : 1
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  inspectVeaArtifacts,
  main,
}
