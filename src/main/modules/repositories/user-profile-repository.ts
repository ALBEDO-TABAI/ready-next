/**
 * Repository for managing user profiles (USER.md data).
 * Supports per-user preferences, communication styles, and customization.
 */

export interface UserProfile {
  id: string
  name?: string
  avatarUrl?: string
  preferredLanguage: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface UserProfileRow {
  id: string
  name: string | null
  avatar_url: string | null
  preferred_language: string
  communication_style: string | null
  preferences_json: string | null
  created_at: number
  updated_at: number
}

export class UserProfileRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    const dbManager = getRepositoryDatabase()
    const db = dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db
  }

  /**
   * Get a user profile by ID
   */
  async getProfile(userId: string): Promise<UserProfile | null> {
    const db = await this.getDatabase()
    const row = db
      .prepare(`SELECT * FROM user_profiles WHERE id = ?`)
      .get(userId) as UserProfileRow | undefined

    if (!row) {
      return null
    }

    return this.rowToProfile(row)
  }

  /**
   * Create a new user profile
   */
  async createProfile(profile: Partial<UserProfile>): Promise<UserProfile> {
    const db = await this.getDatabase()
    const id = profile.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = Date.now()

    const preferencesJson = profile.preferencesJson
      ? JSON.stringify(profile.preferencesJson)
      : null

    db
      .prepare(
        `INSERT INTO user_profiles (
          id, name, avatar_url, preferred_language, communication_style,
          preferences_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        profile.name || null,
        profile.avatarUrl || null,
        profile.preferredLanguage || 'zh',
        profile.communicationStyle || null,
        preferencesJson,
        profile.createdAt || now,
        profile.updatedAt || now
      )

    const created = await this.getProfile(id)
    if (!created) {
      throw new Error(`Failed to create user profile: ${id}`)
    }

    return created
  }

  /**
   * Update an existing user profile
   */
  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<void> {
    const db = await this.getDatabase()
    const existing = await this.getProfile(userId)
    if (!existing) {
      throw new Error(`User profile not found: ${userId}`)
    }

    const preferencesJson = updates.preferencesJson
      ? JSON.stringify(updates.preferencesJson)
      : undefined

    const fields: string[] = []
    const values: unknown[] = []

    if (updates.name !== undefined) {
      fields.push('name = ?')
      values.push(updates.name)
    }
    if (updates.avatarUrl !== undefined) {
      fields.push('avatar_url = ?')
      values.push(updates.avatarUrl)
    }
    if (updates.preferredLanguage !== undefined) {
      fields.push('preferred_language = ?')
      values.push(updates.preferredLanguage)
    }
    if (updates.communicationStyle !== undefined) {
      fields.push('communication_style = ?')
      values.push(updates.communicationStyle)
    }
    if (preferencesJson !== undefined) {
      fields.push('preferences_json = ?')
      values.push(preferencesJson)
    }

    fields.push('updated_at = ?')
    values.push(Date.now())

    values.push(userId)

    db
      .prepare(`UPDATE user_profiles SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  /**
   * List all user profiles
   */
  async listProfiles(): Promise<UserProfile[]> {
    const db = await this.getDatabase()
    const rows = db
      .prepare(`SELECT * FROM user_profiles ORDER BY created_at DESC`)
      .all() as UserProfileRow[]

    return rows.map((row) => this.rowToProfile(row))
  }

  /**
   * Delete a user profile
   */
  async deleteProfile(userId: string): Promise<void> {
    const db = await this.getDatabase()
    db.prepare(`DELETE FROM user_profiles WHERE id = ?`).run(userId)
  }

  /**
   * Convert database row to UserProfile object
   */
  private rowToProfile(row: UserProfileRow): UserProfile {
    return {
      id: row.id,
      name: row.name || undefined,
      avatarUrl: row.avatar_url || undefined,
      preferredLanguage: row.preferred_language,
      communicationStyle: row.communication_style || undefined,
      preferencesJson: row.preferences_json ? JSON.parse(row.preferences_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
