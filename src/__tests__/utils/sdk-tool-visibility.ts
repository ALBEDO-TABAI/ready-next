export interface SdkToolVisibilityLike {
  name: string
  isEnabled?: (context?: unknown) => boolean | Promise<boolean>
}

export async function enabledSdkTools<T extends SdkToolVisibilityLike>(tools: T[]): Promise<T[]> {
  const enabled: T[] = []
  for (const tool of tools) {
    if (!tool.isEnabled || await tool.isEnabled()) enabled.push(tool)
  }
  return enabled
}

export async function enabledSdkToolNames(tools: SdkToolVisibilityLike[]): Promise<string[]> {
  return (await enabledSdkTools(tools)).map((tool) => tool.name)
}
