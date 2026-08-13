export class CodexBindingRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexBindingRepositoryError'
  }
}
