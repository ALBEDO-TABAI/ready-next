declare module 'turndown' {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>)
    addRule(name: string, rule: {
      filter: string | string[] | ((node: unknown) => boolean)
      replacement: (content: string, node: unknown) => string
    }): this
    keep(filter: string | string[] | ((node: unknown) => boolean)): this
    use(plugin: unknown | unknown[]): this
    turndown(input: string): string
  }
}

declare module 'turndown-plugin-gfm' {
  export const gfm: unknown
  export const tables: unknown
  export const strikethrough: unknown
  export const taskListItems: unknown
}
