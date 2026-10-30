export const VAULT_ROOT_SETTING_KEY = 'vault.root'

export type VaultState = { defaultSuggestion: string } & (
  | { status: 'unconfigured'; root?: never }
  | { status: 'ready' | 'missing'; root: string }
)

export interface VaultAPI {
  onChanged(listener: (state: VaultState) => void): () => void
  get(): Promise<VaultState>
  set(path: string): Promise<VaultState>
  createDefault(): Promise<VaultState>
}
