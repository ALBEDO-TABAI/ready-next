#!/usr/bin/env node

import {
  assertTrustedBuildProvenance,
  computeTrustedNodeModulesIdentity,
} from './live-proof-runtime.mjs'

console.log(JSON.stringify(computeTrustedNodeModulesIdentity(process.cwd())))
const identity = assertTrustedBuildProvenance(process.cwd())
console.log(`Trusted build input PASS (${identity.dependencyEntryCount} entries).`)
