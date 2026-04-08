export interface BrowserTabActivationSequencer {
  begin(): number
  invalidate(): number
  isCurrent(token: number): boolean
}

export function createBrowserTabActivationSequencer(): BrowserTabActivationSequencer {
  let currentToken = 0

  return {
    begin() {
      currentToken += 1
      return currentToken
    },
    invalidate() {
      currentToken += 1
      return currentToken
    },
    isCurrent(token) {
      return token === currentToken
    },
  }
}

export const browserTabActivationSequencer = createBrowserTabActivationSequencer()
