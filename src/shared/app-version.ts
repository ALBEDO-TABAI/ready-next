import packageJson from '../../package.json'

/** Application version shown to users and reported to connected services. */
export const APP_VERSION = packageJson.version
export const READY_VERSION_LABEL = `Ready v${APP_VERSION}`
/** Electron major the app runs on; package.json pins the exact version. */
export const ELECTRON_MAJOR_VERSION = packageJson.devDependencies.electron.split('.')[0]
