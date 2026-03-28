/**
 * IPC handlers for user profile and agent personality management
 */

import { ipcMain } from 'electron'
import { UserProfileRepository } from '../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../repositories/agent-personality-repository'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export function setupMemoryManagementIPC(): void {
  const userProfileRepo = new UserProfileRepository()
  const agentPersonalityRepo = new AgentPersonalityRepository()

  // ============================================================
  // User Profile Operations
  // ============================================================

  ipcMain.handle('userProfile:get', async (_, userId: string): Promise<IPCResponse> => {
    try {
      const profile = await userProfileRepo.getProfile(userId)
      return { success: true, data: profile }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('userProfile:list', async (): Promise<IPCResponse> => {
    try {
      const profiles = await userProfileRepo.listProfiles()
      return { success: true, data: profiles }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('userProfile:create', async (_, profile: {
    id?: string
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
  }): Promise<IPCResponse> => {
    try {
      const created = await userProfileRepo.createProfile(profile)
      return { success: true, data: created }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('userProfile:update', async (_, userId: string, updates: {
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
  }): Promise<IPCResponse> => {
    try {
      await userProfileRepo.updateProfile(userId, updates)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('userProfile:delete', async (_, userId: string): Promise<IPCResponse> => {
    try {
      await userProfileRepo.deleteProfile(userId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ============================================================
  // Agent Personality Operations
  // ============================================================

  ipcMain.handle('agentPersonality:get', async (_, agentName: string): Promise<IPCResponse> => {
    try {
      const personality = await agentPersonalityRepo.getPersonality(agentName)
      return { success: true, data: personality }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agentPersonality:list', async (): Promise<IPCResponse> => {
    try {
      const personalities = await agentPersonalityRepo.listPersonalities()
      return { success: true, data: personalities }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agentPersonality:create', async (_, personality: {
    agentName: string
    displayName?: string
    personalityText: string
    tone?: string
  }): Promise<IPCResponse> => {
    try {
      const created = await agentPersonalityRepo.createPersonality(personality)
      return { success: true, data: created }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agentPersonality:update', async (_, agentName: string, updates: {
    displayName?: string
    personalityText?: string
    tone?: string
  }): Promise<IPCResponse> => {
    try {
      await agentPersonalityRepo.updatePersonality(agentName, updates)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agentPersonality:delete', async (_, agentName: string): Promise<IPCResponse> => {
    try {
      await agentPersonalityRepo.deletePersonality(agentName)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
