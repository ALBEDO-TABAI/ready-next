// Binary file extensions — sorted alphabetically within each category. All
// entries lowercase, leading dot. Used by:
//   - document-engine/ipc-handler: skip binary file UTF-8 reads + return
//     local-file:// URLs
//   - search-engine/adapters: skip indexing into FTS5
//
// Lives in its own module so test files can import the set without
// transitively pulling in `electron` (ipc-handler imports `electron` at the
// top, which fails under plain `node --test`).
//
// Hardened 2026-04-25 (perf-rescue B5): pre-hardening size 50 → post 93.
// Added: HEIC/HEIF/RAW + Apple bundle internals + compiled binaries + game
// engine packs + COS / After Effects caches + disk images + Apple iWork +
// game assets + crash dumps. Background: a 25 GB indexing balloon was caused
// by 9.7K .heic photos and ~337K extension-less files that this set used to
// allow through.
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  // Apple / iOS specific
  '.car', '.icns',
  // Apple iWork (large binary documents)
  '.keynote', '.numbers', '.pages',
  // Archives
  '.7z', '.bz2', '.gz', '.rar', '.tar', '.zip',
  // Audio
  '.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.wma',
  // Compiled binaries / object files / debug symbols
  '.a', '.class', '.dll', '.dylib', '.exp', '.lib', '.o', '.obj', '.pdb',
  '.pyc', '.pyo', '.so',
  // Disk images / installers
  '.appimage', '.deb', '.dmg', '.iso', '.msi', '.pkg', '.rpm',
  // Documents (binary, large)
  '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx',
  // Fonts
  '.eot', '.otf', '.ttf', '.woff', '.woff2',
  // Game assets
  '.bsp', '.vpk', '.wad',
  // Images (legacy + modern + RAW)
  '.ai', '.arw', '.avif', '.bmp', '.cr2', '.dng', '.eps', '.gif', '.heic',
  '.heif', '.ico', '.jpeg', '.jpg', '.nef', '.png', '.psd', '.raw', '.svg',
  '.tif', '.tiff', '.webp',
  // Logs / crash dumps (binary core dumps, not text logs)
  '.coredump', '.stackdump',
  // macOS bundles (directories, but caught here as a belt-and-braces guard
  // for the rare cased file with an .app/.framework extension)
  '.app', '.framework',
  // Packed archives — game engine + Tencent COS + After Effects caches
  '.aecache', '.aex', '.asset', '.cos', '.meta', '.pak', '.unity3d',
  // Other native executables
  '.exe',
  // Video
  '.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4', '.webm', '.wmv',
])
