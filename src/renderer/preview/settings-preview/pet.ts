// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
// 预览不加载真实精灵图（避免把 1MB+ 素材打进产物），缩略图走占位。
import type { PetDefinition, PetSettings } from '../../../shared/pet'
import { DEFAULT_PET_SETTINGS } from '../../../shared/pet'

let petSettings: PetSettings = { ...DEFAULT_PET_SETTINGS, enabled: true, selectedPetId: 'white-chinchilla-cat' }

const pet = (id: string, displayName: string, description: string, source: PetDefinition['source'] = 'builtin', available = true): PetDefinition => ({
  id,
  displayName,
  description,
  spritesheetUrl: '',
  spritesheetPath: `pets/${id}/spritesheet.webp`,
  source,
  available,
})

const pets: PetDefinition[] = [
  pet('white-chinchilla-cat', '奶油', '一只白色块状像素金吉拉猫，黑眼睛、粉色小鼻子，蓬松又安静。'),
  pet('cream-gold-cat', '奶茶', '奶金色短毛猫，喜欢趴在窗边晒太阳。'),
  pet('tortoiseshell-cat', '多多', '玳瑁花色，好奇心旺盛，总在桌面边缘巡逻。', 'codex'),
  pet('silver-tabby-cat', '香香', '宠物资源无法读取。', 'codex', false),
]

const ok = <T,>(data: T) => ({ success: true, data })

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  pet: {
    getSettings: async () => ok(petSettings),
    listPets: async () => ok(pets),
    updateSettings: async (patch: Partial<PetSettings>) => {
      petSettings = { ...petSettings, ...patch }
      return ok(petSettings)
    },
    setPet: async (petId: string) => {
      petSettings = { ...petSettings, selectedPetId: petId }
      return ok(petSettings)
    },
    resetPosition: async () => ok(petSettings),
    show: async () => ok(true),
    hide: async () => ok(true),
  },
}
