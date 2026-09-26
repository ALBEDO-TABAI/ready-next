
export class ProviderCredentialFilter {
  private credentialPending = ''
  private bearerPending = ''

  constructor(private readonly credential: string) {}

  push(value: string): string {
    return this.redactBearer(this.redactCredential(value, false), false)
  }

  flush(): string {
    return this.redactBearer(this.redactCredential('', true), true)
  }

  private redactCredential(value: string, flush: boolean): string {
    if (!this.credential) return value
    let remaining = this.credentialPending + value
    let output = ''
    let match = remaining.indexOf(this.credential)
    while (match >= 0) {
      output += `${remaining.slice(0, match)}[REDACTED]`
      remaining = remaining.slice(match + this.credential.length)
      match = remaining.indexOf(this.credential)
    }
    if (!flush) {
      let heldPrefixLength = 0
      const maximum = Math.min(this.credential.length - 1, remaining.length)
      for (let length = maximum; length > 0; length -= 1) {
        if (this.credential.startsWith(remaining.slice(-length))) {
          heldPrefixLength = length
          break
        }
      }
      output += remaining.slice(0, remaining.length - heldPrefixLength)
      this.credentialPending = heldPrefixLength > 0 ? remaining.slice(-heldPrefixLength) : ''
      return output
    }
    this.credentialPending = ''
    return output + remaining
  }

  private redactBearer(value: string, flush: boolean): string {
    const source = this.bearerPending + value
    const lower = source.toLowerCase()
    const marker = 'bearer'
    let output = ''
    let cursor = 0
    this.bearerPending = ''
    while (cursor < source.length) {
      const found = lower.indexOf(marker, cursor)
      if (found < 0) {
        let heldPrefixLength = 0
        if (!flush) {
          const maximum = Math.min(marker.length - 1, source.length - cursor)
          for (let length = maximum; length > 0; length -= 1) {
            if (marker.startsWith(lower.slice(-length))) {
              heldPrefixLength = length
              break
            }
          }
        }
        output += source.slice(cursor, source.length - heldPrefixLength)
        if (heldPrefixLength > 0) this.bearerPending = source.slice(-heldPrefixLength)
        break
      }
      output += source.slice(cursor, found)
      let next = found + marker.length
      if (next === source.length) {
        if (flush) output += source.slice(found)
        else this.bearerPending = source.slice(found)
        break
      }
      if (!/\s/.test(source[next])) {
        output += source[found]
        cursor = found + 1
        continue
      }
      while (next < source.length && /\s/.test(source[next])) next += 1
      if (next === source.length) {
        if (flush) output += source.slice(found)
        else this.bearerPending = source.slice(found)
        break
      }
      const quote = source[next] === '"' || source[next] === "'" ? source[next] : ''
      let tokenEnd = quote ? next + 1 : next
      while (
        tokenEnd < source.length
        && (
          quote
            ? source[tokenEnd] !== quote
            : !/\s/.test(source[tokenEnd]) && source[tokenEnd] !== '"' && source[tokenEnd] !== "'"
        )
      ) tokenEnd += 1
      if (tokenEnd === source.length && !flush) {
        this.bearerPending = source.slice(found)
        break
      }
      output += 'Bearer [REDACTED]'
      cursor = quote && tokenEnd < source.length ? tokenEnd + 1 : tokenEnd
    }
    return output
  }
}
