import { execSync, ExecSyncOptions } from 'child_process'
import { mkdirSync, existsSync, copyFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function getElectronUserDataPath(): string | null {
  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } } | string
    if (typeof electron === 'object') {
      return electron.app?.getPath?.('userData') || null
    }
  } catch {
    return null
  }
  return null
}

export interface Worktree {
  path: string
  branch: string
  agentName: string
}

export interface WorktreeError extends Error {
  code: 'GIT_INIT_FAILED' | 'WORKTREE_CREATE_FAILED' | 'WORKTREE_REMOVE_FAILED' | 'CONFIG_COPY_FAILED'
  originalError?: Error
}

export class WorktreePool {
  private basePath: string
  private worktreesDir: string
  private agentsDir: string
  private activeWorktrees = new Map<string, Worktree>()
  private useMock: boolean
  private gitAvailable: boolean | null = null

  constructor(useMock = false) {
    this.useMock = useMock
    this.basePath = getElectronUserDataPath() || join(process.cwd(), '.ready-data')
    this.worktreesDir = join(this.basePath, '.worktrees')
    this.agentsDir = join(this.basePath, 'agents')
    this.ensureDirectories()

    if (!this.useMock) {
      this.gitAvailable = this.checkGitAvailability()
      if (this.gitAvailable) {
        this.initGitRepo()
      }
    }
  }

  /**
   * Check if git is available
   */
  private checkGitAvailability(): boolean {
    try {
      execSync('git --version', { stdio: 'ignore', timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  private ensureDirectories(): void {
    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true })
    }
    if (!existsSync(this.agentsDir)) {
      mkdirSync(this.agentsDir, { recursive: true })
    }
  }

  private initGitRepo(): void {
    const gitDir = join(this.basePath, '.git')
    if (!existsSync(gitDir)) {
      try {
        execSync('git init', { cwd: this.basePath, stdio: 'ignore' })
        execSync('git config user.email "ready@localhost"', { cwd: this.basePath, stdio: 'ignore' })
        execSync('git config user.name "Ready"', { cwd: this.basePath, stdio: 'ignore' })

        // Create initial commit if no commits exist
        try {
          execSync('git rev-parse HEAD', { cwd: this.basePath, stdio: 'ignore' })
        } catch {
          // No commits yet, create initial commit
          const readmePath = join(this.basePath, 'README.md')
          if (!existsSync(readmePath)) {
            writeFileSync(readmePath, '# Ready Agent Worktrees\n', 'utf-8')
          }
          execSync('git add README.md', { cwd: this.basePath, stdio: 'ignore' })
          execSync('git commit -m "Initial commit"', { cwd: this.basePath, stdio: 'ignore' })
        }
      } catch (error) {
        console.warn('Git init failed (non-fatal):', error)
        this.gitAvailable = false
      }
    }
  }

  /**
   * Acquire a worktree for an agent
   */
  async acquire(agentName: string): Promise<Worktree> {
    const taskId = Date.now()
    const branch = `agent/${agentName}-${taskId}`
    const path = join(this.worktreesDir, `${agentName}-${taskId}`)

    // Try git worktree if available
    if (!this.useMock && this.gitAvailable) {
      try {
        const execOptions: ExecSyncOptions = {
          cwd: this.basePath,
          stdio: 'ignore',
          timeout: 10000
        }
        execSync(`git worktree add "${path}" -b ${branch}`, execOptions)

        const worktree: Worktree = { path, branch, agentName }
        this.activeWorktrees.set(path, worktree)
        this.copyAgentConfig(agentName, path)
        return worktree
      } catch (error) {
        console.warn('Git worktree failed, using directory fallback:', error)
        // Fall through to directory fallback
      }
    }

    // Directory fallback
    try {
      mkdirSync(path, { recursive: true })
      const worktree: Worktree = { path, branch, agentName }
      this.activeWorktrees.set(path, worktree)
      this.copyAgentConfig(agentName, path)
      return worktree
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw this.createWorktreeError('WORKTREE_CREATE_FAILED', errorMessage, error as Error)
    }
  }

  private copyAgentConfig(agentName: string, worktreePath: string): void {
    const agentDir = join(this.agentsDir, agentName)
    const claudeMdSource = join(agentDir, 'CLAUDE.md')
    const claudeMdDest = join(worktreePath, 'CLAUDE.md')

    if (!existsSync(claudeMdSource)) {
      this.createDefaultAgentConfig(agentName, agentDir)
    }

    if (existsSync(claudeMdSource)) {
      try {
        copyFileSync(claudeMdSource, claudeMdDest)
      } catch (error) {
        console.warn('Failed to copy CLAUDE.md:', error)
        // Non-fatal: continue without config
      }
    }
  }

  private createDefaultAgentConfig(agentName: string, agentDir: string): void {
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true })
    }
    const personaContent = this.getDefaultPersona(agentName)
    const claudeMdPath = join(agentDir, 'CLAUDE.md')
    try {
      writeFileSync(claudeMdPath, personaContent, 'utf-8')
    } catch (error) {
      console.warn('Failed to create default agent config:', error)
      // Non-fatal: continue without config
    }
  }

  private getDefaultPersona(agentName: string): string {
    const personas: Record<string, string> = {
      butler: [
        '# 管家 Agent (Butler)',
        '',
        '## 角色定位',
        '你是 Ready 工作台的智能管家，负责理解用户意图并协调其他专业 Agent 完成任务。',
        '',
        '## 核心能力',
        '- **任务分析**: 理解用户的自媒体创作需求，拆解为可执行的子任务',
        '- **Agent 调度**: 根据任务性质分配给合适的专业 Agent（文案/剪辑/分析）',
        '- **流程管理**: 跟踪多 Agent 协作进度，汇总结果并向用户反馈',
        '- **知识整合**: 了解 Ready 工作台的所有功能模块（浏览器/文档/图像/视频/RSS/日历）',
        '',
        '## 行为准则',
        '- 用中文与用户交流，语气专业友好',
        '- 优先理解用户的真实意图，必要时主动询问细节',
        '- 对于简单任务直接完成，复杂任务则说明分工计划后执行',
        '- 在回复中使用 Markdown 格式（标题、列表、代码块）提升可读性',
        '- 如果需要其他 Agent 协作，说明原因和预期结果',
        '',
        '## Ready 工作台功能',
        '- 浏览器模式: 内置浏览器，可登录社交平台',
        '- 文档模式: Markdown 编辑、docx/xlsx/pdf 查看',
        '- 图像模式: 图片编辑和处理',
        '- 视频模式: 视频剪辑和转码',
        '- RSS 模式: 信息源订阅和阅读',
        '- 日历模式: 发布计划和事件管理'
      ].join('\n'),

      copywriter: [
        '# 文案 Agent (Copywriter)',
        '',
        '## 角色定位',
        '你是专业的自媒体文案创作专家，精通各平台的内容策略和写作技巧。',
        '',
        '## 核心能力',
        '- **平台适配**: 熟悉抖音/小红书/微信公众号/B站/微博等平台的内容规范和爆款特征',
        '- **SEO 优化**: 掌握关键词布局、标题优化、标签策略',
        '- **创意写作**: 能够创作吸引眼球的标题、引人入胜的正文、有效的 CTA',
        '- **内容改写**: 根据不同平台特性改写同一内容，实现一稿多投',
        '- **文案润色**: 优化语言表达、调整语气风格、修正语法错误',
        '',
        '## 写作风格',
        '- 根据目标平台和受众调整语气（专业/轻松/幽默/煽情）',
        '- 善用 emoji、分段、列表提升移动端阅读体验',
        '- 注重开头吸引力（黄金3秒法则）和结尾引导互动',
        '',
        '## 行为准则',
        '- 用中文创作，除非用户明确要求其他语言',
        '- 在创作前确认：目标平台、受众画像、内容主题、期望风格',
        '- 提供多个版本供选择，并说明各版本的策略差异',
        '- 使用 Markdown 格式组织输出内容'
      ].join('\n'),

      'video-editor': [
        '# 剪辑 Agent (Video Editor)',
        '',
        '## 角色定位',
        '你是专业的视频制作顾问，精通视频剪辑理论、叙事节奏和技术流程。',
        '',
        '## 核心能力',
        '- **脚本策划**: 根据主题创作视频分镜脚本、旁白文稿',
        '- **剪辑指导**: 提供剪辑节奏建议、转场选择、画面构图指导',
        '- **技术支持**: 了解视频编码格式、分辨率、比特率等技术参数',
        '- **平台规范**: 熟悉各平台的视频规格要求（时长/比例/封面）',
        '- **字幕配音**: 提供字幕文案、配音脚本建议',
        '',
        '## 专业知识',
        '- 叙事结构: 三幕式、倒叙、平行叙事等手法',
        '- 节奏控制: 快剪/慢放/定格/跳切的应用场景',
        '- 音视频同步: BGM 选择、音效设计、节奏卡点',
        '- 后期处理: 调色风格、特效应用、图形动画',
        '',
        '## 行为准则',
        '- 用中文交流，专业术语附带简要解释',
        '- 输出结构化的脚本格式（时间码 + 画面描述 + 旁白/字幕）',
        '- 提供具体可操作的建议，而非笼统的方向',
        '- 了解 Ready 工作台的视频处理能力（裁剪/转码/抽帧/提取音频）'
      ].join('\n'),

      analyst: [
        '# 分析 Agent (Analyst)',
        '',
        '## 角色定位',
        '你是自媒体数据分析专家，擅长从数据中发现趋势、洞察和可执行的增长策略。',
        '',
        '## 核心能力',
        '- **数据解读**: 分析播放量/点赞/评论/分享/完播率等核心指标',
        '- **趋势发现**: 识别内容热点、平台算法变化、受众偏好漂移',
        '- **竞品分析**: 对标同类账号，分析内容策略差异和增长路径',
        '- **受众洞察**: 分析粉丝画像、活跃时段、互动偏好',
        '- **策略建议**: 基于数据提出内容优化、发布时机、增长策略',
        '',
        '## 分析方法',
        '- 定量分析: 数据对比、趋势图表、增长率计算',
        '- 定性分析: 评论情感分析、内容主题归类、用户需求提炼',
        '- A/B 测试建议: 标题测试、封面测试、发布时间测试',
        '',
        '## 行为准则',
        '- 用中文输出分析报告，数据呈现清晰',
        '- 使用 Markdown 表格和列表组织数据',
        '- 每个分析结论附带数据支撑',
        '- 提供可执行的优化建议（What → Why → How）',
        '- 区分「事实」和「推测」，标注置信度'
      ].join('\n')
    }
    return personas[agentName] || personas['butler']
  }

  /**
   * Release a worktree
   */
  async release(worktreePath: string): Promise<void> {
    const worktree = this.activeWorktrees.get(worktreePath)
    if (!worktree) return

    // Try git worktree remove if available
    if (!this.useMock && this.gitAvailable) {
      try {
        const execOptions: ExecSyncOptions = {
          cwd: this.basePath,
          stdio: 'ignore',
          timeout: 10000
        }
        execSync(`git worktree remove "${worktreePath}" --force`, execOptions)
        this.activeWorktrees.delete(worktreePath)
        return
      } catch (error) {
        console.warn('Git worktree remove failed, using directory fallback:', error)
        // Fall through to directory fallback
      }
    }

    // Directory fallback
    try {
      rmSync(worktreePath, { recursive: true, force: true })
    } catch (error) {
      console.warn('Failed to remove worktree directory:', error)
      // Non-fatal: just remove from tracking
    }

    this.activeWorktrees.delete(worktreePath)
  }

  getActiveWorktrees(): Worktree[] {
    return Array.from(this.activeWorktrees.values())
  }

  async cleanup(): Promise<void> {
    const errors: Error[] = []

    for (const [path] of this.activeWorktrees) {
      try {
        await this.release(path)
      } catch (error) {
        errors.push(error as Error)
      }
    }

    if (errors.length > 0) {
      console.warn(`Worktree cleanup completed with ${errors.length} errors:`, errors)
    }
  }

  /**
   * Get diagnostic information about the worktree pool
   */
  getDiagnostics(): {
    gitAvailable: boolean
    useMock: boolean
    basePath: string
    activeWorktrees: number
    worktreePaths: string[]
  } {
    return {
      gitAvailable: this.gitAvailable ?? false,
      useMock: this.useMock,
      basePath: this.basePath,
      activeWorktrees: this.activeWorktrees.size,
      worktreePaths: Array.from(this.activeWorktrees.keys())
    }
  }

  private createWorktreeError(
    code: WorktreeError['code'],
    message: string,
    originalError?: Error
  ): WorktreeError {
    const error = new Error(message) as WorktreeError
    error.code = code
    error.originalError = originalError
    return error
  }
}
