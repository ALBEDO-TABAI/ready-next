export class SettingsRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    return getRepositoryDatabase()
  }

  async getSetting(key: string): Promise<string | undefined> {
    return (await this.getDatabase()).getSetting(key)
  }

  async setSetting(key: string, value: string): Promise<void> {
    ;(await this.getDatabase()).setSetting(key, value)
  }
}
