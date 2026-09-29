import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Database Schema Validation', () => {

    it('should load better-sqlite3 through createRequire for ESM main-process compatibility', () => {
        const databaseModule = readFileSync(resolve(process.cwd(), 'src/main/modules/database.ts'), 'utf8')
        assert.match(databaseModule, /createRequire\(import\.meta\.url\)/)
        assert.match(databaseModule, /const require = createRequire\(import\.meta\.url\)/)
        assert.match(databaseModule, /require\('better-sqlite3'\)/)
    })
})
