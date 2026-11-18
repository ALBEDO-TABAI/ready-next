import { getDatabase } from '../database'
import { RSSPictureService } from './picture-service'

let service: RSSPictureService | null = null

export function getRSSPictureService(): RSSPictureService {
  if (!service) service = new RSSPictureService({ store: getDatabase().rss.pictures })
  return service
}

export async function stopRSSPictureService(): Promise<void> {
  service?.dispose()
  await service?.idle()
}
