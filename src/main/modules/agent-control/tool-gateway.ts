/**
 * Tool gateway is the single registry for module tools that the orchestrator can use.
 * The current implementation focuses on discovery/metadata; execution is delegated to
 * existing module IPC handlers and direct-chat internal tool routing.
 */

export interface ToolDescriptor {
  id: string
  group: string
  description: string
  module?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  family?: string
}

const DEFAULT_TOOLS: ToolDescriptor[] = [
  { id: 'document.open', group: 'document', module: 'document', family: 'document_*', executionKind: 'deterministic', description: 'Open and inspect documents' },
  { id: 'document.write', group: 'document', module: 'document', family: 'document_*', executionKind: 'deterministic', description: 'Edit document content' },
  { id: 'browser.navigate', group: 'browser', module: 'browser', family: 'browser_*', executionKind: 'interactive', description: 'Open and navigate web pages' },
  { id: 'browser.extract', group: 'browser', module: 'browser', family: 'browser_*', executionKind: 'interactive', description: 'Extract page context and selection' },
  { id: 'calendar.list', group: 'calendar', module: 'calendar', family: 'calendar_*', executionKind: 'deterministic', description: 'List events in a time range' },
  { id: 'calendar.create', group: 'calendar', module: 'calendar', family: 'calendar_*', executionKind: 'deterministic', description: 'Create/update calendar events' },
  { id: 'feishu.im', group: 'feishu', module: 'feishu', family: 'feishu_*', executionKind: 'interactive', description: 'Read and reply to Feishu messages' },
  { id: 'feishu.doc', group: 'feishu', module: 'feishu', family: 'feishu_*', executionKind: 'interactive', description: 'Create and edit Feishu docs' },
  { id: 'feishu.bitable', group: 'feishu', module: 'feishu', family: 'feishu_*', executionKind: 'deterministic', description: 'Read and write Feishu bitable rows' },
  { id: 'feishu.calendar', group: 'feishu', module: 'feishu', family: 'feishu_*', executionKind: 'deterministic', description: 'Manage Feishu calendar events' },
  { id: 'feishu.task', group: 'feishu', module: 'feishu', family: 'feishu_*', executionKind: 'deterministic', description: 'Manage Feishu tasks' },
  { id: 'filesystem.read', group: 'filesystem', module: 'system', family: 'system_*', executionKind: 'deterministic', description: 'Read/list files and directories' },
  { id: 'filesystem.write', group: 'filesystem', module: 'system', family: 'system_*', executionKind: 'deterministic', description: 'Create/move/delete files and folders' },
  { id: 'rss.fetch', group: 'rss', module: 'rss', family: 'rss_*', executionKind: 'deterministic', description: 'Fetch and refresh RSS feeds' },
  { id: 'rss.analyze', group: 'rss', module: 'rss', family: 'rss_*', executionKind: 'pipeline', description: 'Run RSS item analysis pipelines' },
]

export class ToolGateway {
  private readonly tools: ToolDescriptor[]
  private readonly toolIndex = new Map<string, ToolDescriptor>()

  constructor(initialTools: ToolDescriptor[] = DEFAULT_TOOLS) {
    this.tools = [...initialTools]
    for (const tool of this.tools) {
      this.toolIndex.set(tool.id, tool)
    }
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

  getTool(id: string): ToolDescriptor | null {
    return this.toolIndex.get(id) || null
  }

  hasTool(id: string): boolean {
    return this.toolIndex.has(id)
  }

  listByModule(module: string): ToolDescriptor[] {
    return this.tools.filter((tool) => tool.module === module)
  }
}
