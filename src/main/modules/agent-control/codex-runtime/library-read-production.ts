import type { DatabaseManager } from '../../database'
import { LibraryReadResources } from './library-read-resources'
import { LibraryReadSources, libraryFailure } from './library-read-sources'
import { ObjectRegistry } from '../../object-service/registry'

export async function productionLibraryReader(database: DatabaseManager): Promise<LibraryReadResources> {
  try {
    const [{ app }, { VaultService }, { AppSettingsRepository }] = await Promise.all([
      import('electron'), import('../../settings-engine/vault-service'), import('../../repositories/app-settings-repository'),
    ])
    const vault = new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged }).get()
    const db = database.getRawDb()
    if (!db || vault.status !== 'ready') return libraryFailure()
    return new LibraryReadResources(new LibraryReadSources(new ObjectRegistry(db), vault.root, database.calendar))
  } catch {
    // silent-catch: return a fixed resource failure without disclosing filesystem paths or content.
    return libraryFailure()
  }
}
