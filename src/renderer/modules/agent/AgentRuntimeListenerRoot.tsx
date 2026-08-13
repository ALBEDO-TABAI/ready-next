import { useLayoutEffect } from 'react'
import { initAgentListeners } from '../../stores/useAgent'

type AgentListenerInstaller = () => () => void

function AgentRuntimeListenerOwner({ install }: { install: AgentListenerInstaller }) {
  useLayoutEffect(() => install(), [install])
  return null
}

export default function AgentRuntimeListenerRoot() {
  return <AgentRuntimeListenerOwner install={initAgentListeners} />
}

export function AgentRuntimeListenerOwnerTestHarness({ install }: { install: AgentListenerInstaller }) {
  return <AgentRuntimeListenerOwner install={install} />
}
