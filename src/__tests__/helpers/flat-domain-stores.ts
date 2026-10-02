/**
 * DatabaseManager exposes domain stores (`chat`, `channels`, `settings`, …).
 * Unit fakes that only implement a handful of flat methods can be served to
 * every domain at once; the fake still fails loudly on any method it lacks.
 */
export function flatDomainStores<T extends object>(store: T) {
  return { chat: store, channels: store, settings: store, browser: store, calendar: store, rss: store }
}
