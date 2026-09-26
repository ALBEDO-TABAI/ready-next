import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { loadRuntimeContinuityAssets } from '../main/modules/agent-control/codex-runtime/codex-runtime-continuity-assets'
import { resolve } from 'node:path'

const read = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8'))

test('provider extension preserves native history contracts and verifiable prior continuity proofs', () => {
  const root = 'assets/runtime-continuity/'
  const current = read('assets/codex-runtime/runtime-manifest.json')
  const target = digestCanonicalJson(current)
  const transitions = read(root + 'runtime-continuity-transitions.json')
  const catalog = loadRuntimeContinuityAssets({ assetRoot: resolve(root), targetManifestDigest: target }).catalog
  assert.equal(catalog.transitions.length, transitions.transitions.length)
  for (const edge of transitions.transitions) {
    const proof = read(root + edge.evidenceFile)
    assert.equal(digestCanonicalJson(proof), edge.proofDigest)
    if (proof.derivation?.evidenceKind !== 'additive_host_provider_contract') continue
    const previous = read(root + 'manifests/0.149.0-cda6bd5f.json')
    assert.equal(digestCanonicalJson(previous), proof.derivation.priorTargetManifestDigest)
    const native = ({ modelGatewayContractDigest: _host, ...rest }: Record<string, unknown>) => rest
    assert.deepEqual(native(current), native(previous), 'no implicit compatibility after native binary/schema changes')
    if (proof.priorNativeProof) {
      const prior = read(root + proof.priorNativeProof.evidenceFile)
      assert.equal(digestCanonicalJson(prior), proof.priorNativeProof.proofDigest)
      assert.equal(prior.sourceManifestDigest, edge.sourceManifestDigest)
      assert.equal(prior.operation, edge.operation)
      assert.equal(prior.result, edge.result)
      assert.equal(prior.targetManifestDigest, proof.derivation.priorTargetManifestDigest)
    } else assert.equal(edge.sourceManifestDigest, proof.derivation.priorTargetManifestDigest)
  }
})
