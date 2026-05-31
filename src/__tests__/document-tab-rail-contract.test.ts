import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document mode uses a browser-style document tab rail with hover hints and a pinned new-tab button', () => {
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const documentTabRail = readWorkspaceFile('src/renderer/components/document/DocumentTabRail.tsx')

  assert.match(documentMode, /import DocumentTabRail from ['"]\.\.\/\.\.\/components\/document\/DocumentTabRail['"]/)
  assert.match(documentMode, /<DocumentTabRail/)
  assert.doesNotMatch(documentMode, /<WorkbenchProjectTabs/)

  assert.match(documentTabRail, /getTabRailLayoutMetrics/)
  assert.match(documentTabRail, /const \[hoveredTabId, setHoveredTabId\] = useState<string \| null>\(null\)/)
  assert.match(documentTabRail, /const \[showLeftArrow, setShowLeftArrow\] = useState\(false\)/)
  assert.match(documentTabRail, /const \[showRightArrow, setShowRightArrow\] = useState\(false\)/)
  assert.match(documentTabRail, /overflow-x-auto/)
  assert.match(documentTabRail, /scrollTo\(\{\s*left:\s*targetLeft/)
  assert.match(documentTabRail, /text-\[12px\]/)
  assert.match(documentTabRail, /onMouseEnter=\{\(\) => setHoveredTabId\(tab\.id\)\}/)
  assert.match(documentTabRail, /onMouseLeave=\{\(\) => setHoveredTabId\(\(current\) => current === tab\.id \? null : current\)\}/)
  assert.match(documentTabRail, /borderColor: isDragOver/)
  assert.match(documentTabRail, /boxShadow: isHovered/)
  assert.match(documentTabRail, /contentClassName="relative z-\[1\] flex min-w-0 flex-1 items-center justify-center"/)
  assert.match(documentTabRail, /const leftReserve = tab\.dotColor \? 28 : 0/)
  assert.match(documentTabRail, /className="flex min-w-0 items-center justify-center"/)
  assert.match(documentTabRail, /maxWidth: `calc\(100% - \$\{leftReserve \+ rightReserve\}px\)`/)
  assert.match(documentTabRail, /marginLeft: leftReserve/)
  assert.match(documentTabRail, /marginRight: rightReserve/)
  assert.match(documentTabRail, /className="absolute left-\[8px\] top-1\/2 flex items-center justify-center"/)
  assert.match(documentTabRail, /className="absolute right-\[8px\] top-1\/2 flex items-center justify-center/)
  assert.match(documentTabRail, /document-tab-rail-scroll[\s\S]*?onClick=\{\(\) => void onNewTab\(\)\}/)
  assert.match(documentTabRail, /className="ml-\[6px\] flex h-\[28px\] w-\[28px\] flex-shrink-0 items-center justify-center rounded-\[8px\] transition-colors hover:bg-\[var\(--bg-hover\)\]"/)
})
