// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import type { ChatGptOAuthStatus } from '../../../shared/chatgpt-oauth'

const chatGptOAuthStatus: ChatGptOAuthStatus = {
  state: 'signed_out',
  connected: false,
  running: false,
  baseUrl: 'http://127.0.0.1:1455',
  models: [],
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  settings: {
    getChatGptOAuthStatus: async () => ({ success: true, data: chatGptOAuthStatus }),
    connectChatGptOAuth: async () => ({ success: true, data: chatGptOAuthStatus }),
    resumeChatGptOAuth: async () => ({ success: true, data: chatGptOAuthStatus }),
    disconnectChatGptOAuth: async () => ({ success: true, data: chatGptOAuthStatus }),
    cancelChatGptOAuth: async () => ({ success: true }),
    reopenChatGptOAuth: async () => ({ success: true }),
  },
}
