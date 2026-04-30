export function disposeTimeout(timeout: ReturnType<typeof setTimeout> | null): void {
  if (timeout) clearTimeout(timeout)
}
