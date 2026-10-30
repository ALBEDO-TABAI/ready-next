import { accessSync, constants, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { assertReadyNextDataIsolation } from '../../ready-next-data-isolation'
import { VAULT_ROOT_SETTING_KEY, type VaultState } from '../../../shared/vault'

interface VaultSettings {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

export class VaultService {
  constructor(
    private readonly settings: VaultSettings,
    private readonly environment: { home: string; userData: string; isPackaged: boolean },
  ) {}

  private get defaultSuggestion(): string {
    return this.environment.isPackaged
      ? join(this.environment.home, 'Documents', 'Ready')
      : join(this.environment.userData, 'test-vault')
  }

  private validate(path: unknown): string {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('资料库必须是绝对路径。')
    const root = resolve(path)
    const validation = validateWorkspaceRoot(root, { homeDir: this.environment.home })
    if (!validation.ok) throw new Error(validation.message)
    assertReadyNextDataIsolation(
      this.environment.userData, root, this.environment.home,
      this.environment.isPackaged ? [] : [join(this.environment.home, 'Documents', 'Ready')],
    )
    return root
  }

  get(): VaultState {
    const defaultSuggestion = this.defaultSuggestion
    const saved = this.settings.getSetting(VAULT_ROOT_SETTING_KEY)
    if (saved === undefined) return { status: 'unconfigured', defaultSuggestion }
    const root = resolve(saved)
    try {
      this.validate(saved)
      this.validate(realpathSync(root))
      if (!statSync(root).isDirectory()) return { status: 'missing', root, defaultSuggestion }
      accessSync(root, constants.R_OK)
      return { status: 'ready', root, defaultSuggestion }
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return { status: 'missing', root, defaultSuggestion }
      }
      throw error
    }
  }

  set(path: unknown): VaultState {
    const root = this.validate(realpathSync(this.validate(path)))
    if (!statSync(root).isDirectory()) throw new Error('资料库必须是文件夹。')
    accessSync(root, constants.R_OK)
    this.settings.setSetting(VAULT_ROOT_SETTING_KEY, root)
    return this.get()
  }

  createDefault(): VaultState {
    const root = this.validate(this.defaultSuggestion)
    mkdirSync(root, { recursive: true })
    return this.set(root)
  }
}
