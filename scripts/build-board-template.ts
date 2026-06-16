import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { createReadyBoardTemplate } from '../src/board/engine'

const target = resolve('assets/board/board-template.html')
const expected = createReadyBoardTemplate()
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  const current = await readFile(target, 'utf8').catch(() => '')
  if (current !== expected) {
    console.error('assets/board/board-template.html is stale. Run npm run build:board-template.')
    process.exit(1)
  }
  console.log('Board template is fresh.')
} else {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, expected, 'utf8')
  console.log(`Wrote ${target}`)
}
