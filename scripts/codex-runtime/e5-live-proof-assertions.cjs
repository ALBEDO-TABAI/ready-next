function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertManualGatewayCaptureTurnIdentities(input) {
  assert(Array.isArray(input.gatewayCapture), 'manual gateway capture must be an array')
  assert(Array.isArray(input.productTurns) && input.productTurns.length === 3,
    'manual product turn fixture must contain exactly three turns')
  const productCaptures = input.gatewayCapture.filter((entry) => entry.requestKind === 'product')
  const manualCaptures = input.gatewayCapture.filter((entry) => entry.requestKind === 'manual_compaction')
  assert(productCaptures.length === 3 && manualCaptures.length === 1,
    'manual gateway capture kind identity mismatch')
  assert(manualCaptures[0].turnId === input.manualCompactionTurnId,
    'manual compaction gateway turn identity mismatch')
  assert(productCaptures.every((entry, index) => (
    entry.turnId === input.productTurns[index].codexTurnId
    && entry.readyRunId === input.productTurns[index].readyRunId
  )), 'manual product gateway turn identity mismatch')
}

function parseMacProcessRows(output) {
  return String(output).split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/,
    )
    if (!match) return []
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const processGroupId = Number(match[3])
    const command = match[9]
    const executableToken = command.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/)
    const executablePath = executableToken?.[1] || executableToken?.[2] || executableToken?.[3] || ''
    if (![pid, parentPid, processGroupId].every(Number.isSafeInteger) || !executablePath) return []
    return [{
      pid,
      parentPid,
      processGroupId,
      processStartIdentity: `${pid}:${match.slice(4, 9).join(' ')}`,
      executablePath,
      command,
    }]
  })
}

module.exports = { assertManualGatewayCaptureTurnIdentities, parseMacProcessRows }
