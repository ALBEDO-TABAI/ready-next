const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const author = '/Users/user/实验田/skill-fac/tag-forge'
const bundled = join(process.cwd(), 'assets/embedded-skills/tag-forge')
const ignored = new Set(['.DS_Store', 'ready-skill.json'])
function files(root, dir=root){return readdirSync(dir).flatMap((name)=>{if(ignored.has(name))return[];const path=join(dir,name);return statSync(path).isDirectory()?files(root,path):[relative(root,path)]}).sort()}
if(!existsSync(author)) throw new Error(`Tag Forge author source missing: ${author}`)
const a=files(author);const b=files(bundled)
if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error(`Tag Forge file parity failed\nauthor=${a.join(',')}\nbundled=${b.join(',')}`)
for(const file of a){if(readFileSync(join(author,file)).compare(readFileSync(join(bundled,file)))!==0)throw new Error(`Tag Forge content parity failed: ${file}`)}
const skill=readFileSync(join(bundled,'SKILL.md'),'utf8')
for(const match of skill.matchAll(/\]\(\.\/([^\)]+)\)/g)){if(!existsSync(join(bundled,match[1])))throw new Error(`Broken Tag Forge relative link: ${match[1]}`)}
if(/['"`]tf['"`]/i.test(skill)) throw new Error('Unimplemented tf alias remains advertised')
if(/写回\s*tag-lexicon\.yaml/.test(skill)) throw new Error('Bundled read-only lexicon is still advertised as writable')
console.log(`[check-tag-forge-parity] OK (${a.length} shared files)`)
