import { TreasureIndex, TREASURE_SENTINEL } from './treasure'
import { downloadCtfile, parseLink, CTFILE_SENTINEL } from './ctfile'
export function extraSources(cache: string) {
  return { index: new TreasureIndex(cache), download: downloadCtfile, parseLink, sentinels: [TREASURE_SENTINEL, CTFILE_SENTINEL] }
}
