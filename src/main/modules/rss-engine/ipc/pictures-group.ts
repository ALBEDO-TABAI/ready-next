import { RSSPictureLookupSchema } from '../../../../shared/rss-pictures'
import type { RSSPictureService } from '../picture-service'
import type { IpcChannelGroup } from './types'

const CHANNEL = 'rss:lookupPictures'

export const picturesGroup: IpcChannelGroup<{ service(): RSSPictureService }> = {
  namespace: 'rss:pictures',
  register(ipcMain, deps) {
    ipcMain.removeHandler(CHANNEL)
    ipcMain.handle('rss:lookupPictures', async (_event, input: unknown) => {
      try {
        const { itemIds } = RSSPictureLookupSchema.parse(input)
        return { success: true, data: { pictures: await deps.service().lookup(itemIds) } }
      } catch (error) {
        // silent-catch: validation and lookup errors are returned to the requesting window.
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    return { dispose: () => ipcMain.removeHandler(CHANNEL) }
  },
}
