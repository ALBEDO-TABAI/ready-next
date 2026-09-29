const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ignored = new Set(['.DS_Store', 'ready-skill.json'])
function files(root, dir = root) {
  return readdirSync(dir).flatMap((name) => {
    if (ignored.has(name)) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(root, path) : [relative(root, path)]
  }).sort()
}

function checkTagForgeBundle(bundled, author) {
  const bundledFiles = files(bundled)
  // The repository gate validates the shipped bundle. Author-copy parity is an
  // explicit local check, since the author workspace is not a build input.
  if (author) {
    if (!existsSync(author)) throw new Error(`Tag Forge author source missing: ${author}`)
    const authorFiles = files(author)
    if (JSON.stringify(authorFiles) !== JSON.stringify(bundledFiles)) throw new Error('Tag Forge file parity failed')
    for (const file of authorFiles) {
      if (!readFileSync(join(author, file)).equals(readFileSync(join(bundled, file)))) {
        throw new Error(`Tag Forge content parity failed: ${file}`)
      }
    }
  }
  const skill = readFileSync(join(bundled, 'SKILL.md'), 'utf8')
  for (const match of skill.matchAll(/\]\(\.\/([^)]+)\)/g)) {
    if (!existsSync(join(bundled, match[1]))) throw new Error(`Broken Tag Forge relative link: ${match[1]}`)
  }
  if (/['"`]tf['"`]/i.test(skill)) throw new Error('Unimplemented tf alias remains advertised')
  if (/写回\s*tag-lexicon\.yaml/.test(skill)) throw new Error('Bundled read-only lexicon is still advertised as writable')
  return bundledFiles.length
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--author' || !args[1])) {
    throw new Error('Usage: node scripts/check-tag-forge-parity.cjs [--author <directory>]')
  }
  const count = checkTagForgeBundle(join(process.cwd(), 'assets/embedded-skills/tag-forge'), args[1])
  console.log(`[check-tag-forge-parity] OK (${count} bundled files; author parity ${args[1] ? 'checked' : 'not requested'})`)
}

module.exports = { checkTagForgeBundle }
