'use strict'

const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } = require('node:fs')
const { resolve, relative } = require('node:path')

function sha256File(filePath) {
  statSync(filePath)
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function computeTreeIdentity(rootPath, options = {}) {
  const absoluteRoot = realpathSync(rootPath)
  const excludedRelativePaths = new Set(options.excludeRelativePaths || [])
  const rows = []
  let fileBytes = 0
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (options.excludePythonBytecode === true
        && (entry.name === '__pycache__' || /\.py[co]$/i.test(entry.name))) continue
      const absolutePath = resolve(directory, entry.name)
      const logicalPath = relative(absoluteRoot, absolutePath)
      if (excludedRelativePaths.has(logicalPath)) continue
      const stats = lstatSync(absolutePath)
      if (stats.isSymbolicLink()) {
        rows.push(`L\0${logicalPath}\0${readlinkSync(absolutePath)}\n`)
      } else if (stats.isDirectory()) {
        rows.push(`D\0${logicalPath}\0${stats.mode}\n`)
        visit(absolutePath)
      } else if (stats.isFile()) {
        const content = readFileSync(absolutePath)
        fileBytes += content.length
        rows.push(`F\0${logicalPath}\0${stats.mode}\0${content.length}\0${createHash('sha256').update(content).digest('hex')}\n`)
      } else {
        throw new Error('pinned_tree_entry_type_unsupported')
      }
    }
  }
  visit(absoluteRoot)
  return Object.freeze({
    root: absoluteRoot,
    digest: createHash('sha256').update(rows.join('')).digest('hex'),
    entryCount: rows.length,
    fileBytes,
  })
}

module.exports = { sha256File, computeTreeIdentity }
