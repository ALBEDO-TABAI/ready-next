/**
 * Tool gateway is the single registry for module tools that the orchestrator can use.
 * The current implementation focuses on discovery/metadata; execution is delegated to
 * existing module IPC handlers and direct-chat internal tool routing.
 */

export interface ToolDescriptor {
  id: string
  group: string
  description: string
}

const DEFAULT_TOOLS: ToolDescriptor[] = [
  { id: 'document.open', group: 'document', description: 'Open and inspect documents' },
  { id: 'document.write', group: 'document', description: 'Edit document content' },
  { id: 'browser.navigate', group: 'browser', description: 'Open and navigate web pages' },
  { id: 'browser.extract', group: 'browser', description: 'Extract page context and selection' },
  { id: 'design.load', group: 'design', description: 'Load design project and state' },
  { id: 'design.update', group: 'design', description: 'Apply design edits' },
  { id: 'video.inspect', group: 'video', description: 'Inspect media metadata and timeline clips' },
  { id: 'video.render', group: 'video', description: 'Render timeline output' },
  { id: 'calendar.list', group: 'calendar', description: 'List events in a time range' },
  { id: 'calendar.create', group: 'calendar', description: 'Create/update calendar events' },
  { id: 'filesystem.read', group: 'filesystem', description: 'Read/list files and directories' },
  { id: 'filesystem.write', group: 'filesystem', description: 'Create/move/delete files and folders' },
  { id: 'rss.fetch', group: 'rss', description: 'Fetch and refresh RSS feeds' },
  { id: 'rss.analyze', group: 'rss', description: 'Run RSS item analysis pipelines' },
]

export class ToolGateway {
  private readonly tools: ToolDescriptor[]

  constructor(initialTools: ToolDescriptor[] = DEFAULT_TOOLS) {
    this.tools = [...initialTools]
  }

  listTools(): ToolDescriptor[] {
    return [...this.tools]
  }

  count(): number {
    return this.tools.length
  }

  listToolGroups(): string[] {
    const groups = new Set<string>()
    for (const tool of this.tools) groups.add(tool.group)
    return Array.from(groups)
  }
}
