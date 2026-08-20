import {
  fileReferenceDirectory,
  fileReferenceLabel,
  type MentionResolution,
} from './local-reference'

function openLocalPath(path: string): void {
  void window.electronAPI?.document?.openPath?.(path).catch(() => undefined)
}

export function LocalFileChip({
  path,
  line = null,
}: {
  path: string
  line?: number | null
}) {
  const directory = fileReferenceDirectory(path)
  const label = fileReferenceLabel(path, line)
  return (
    <span
      className="ready-local-ref-chip"
      data-ready-local-ref="file"
      title={path}
    >
      {directory ? <span className="ready-local-ref-chip-dir">{directory}</span> : null}
      <button
        type="button"
        className="ready-local-ref-chip-file"
        onClick={() => openLocalPath(path)}
      >
        {label}
      </button>
    </span>
  )
}

export function LocalMentionChip({
  name,
  resolution,
}: {
  name: string
  resolution?: MentionResolution | null
}) {
  const path = resolution?.path
  if (path) {
    return <LocalFileChip path={path} line={resolution?.line ?? null} />
  }
  return (
    <span
      className="ready-local-ref-chip ready-local-ref-chip-mention"
      data-ready-local-ref="mention"
      title={name}
    >
      <span className="ready-local-ref-chip-at">@</span>
      <span className="ready-local-ref-chip-name">{name}</span>
    </span>
  )
}
