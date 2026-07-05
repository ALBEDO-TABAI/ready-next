/**
 * D18-d（真机第十六轮实锚）—— agent 自注入输入直通登记。
 *
 * 事实链：`Input.dispatchKeyEvent`/`Input.dispatchMouseEvent`（CDP 注入）
 * **会**触发 Electron 的 before-input-event / before-mouse-event——
 * attachAgentTabSupervision 的旧注释假设（"agent 写入不经过它"）不成立。
 * 第十六轮真机后果三连：agent 的 send_keys 触发自家接管闸（凭空
 * pending_confirm 胶囊）；键击被 preventDefault 吞掉（模型的 Cmd+A/
 * Backspace 修复静默失效，页面状态与模型认知脱节 → 标题区死循环）；
 * 被吞的 Meta 组合键落穿到应用菜单/系统层（两次 Cmd+A 与两次窗口缩放
 * 动画毫秒级对齐）。
 *
 * 修法：自动化通道在派发 CDP 输入前，把"即将出现的输入身份"登记进本
 * 注册表（键=按键标签集合+时限窗，鼠标=时限窗）；两个 before-*-event
 * 守卫先查表——命中者是 agent 自己的输入，放行且不举升接管；未命中的
 * 才是真实用户输入，接管语义原样。窗口很短（默认 1.2s，CDP 事件在派发
 * 后毫秒级到达），真实用户恰好同刻按下同一按键的暴露面可忽略。
 */

const DEFAULT_PASSTHROUGH_WINDOW_MS = 1200

export class AgentInputPassthroughRegistry {
  private readonly now: () => number
  private keyLabels = new Set<string>()
  private keysExpireAt = 0
  private mouseExpireAt = 0

  constructor(deps?: { now?: () => number }) {
    this.now = deps?.now ?? (() => Date.now())
  }

  /** 派发键序列前登记：labels 为本次会出现的全部按键标签（含修饰键）。 */
  beginKeys(labels: readonly string[], windowMs = DEFAULT_PASSTHROUGH_WINDOW_MS): void {
    const at = this.now() + windowMs
    if (this.now() > this.keysExpireAt) this.keyLabels.clear()
    for (const label of labels) {
      const normalized = String(label || '').toLowerCase()
      if (normalized) this.keyLabels.add(normalized)
    }
    this.keysExpireAt = at
  }

  /** before-input-event 侧查询：是 agent 刚登记的键则放行。不消耗
   * （一次按键产生 keyDown/char/keyUp 多个事件）。 */
  matchKey(label: string): boolean {
    if (this.now() > this.keysExpireAt) {
      if (this.keyLabels.size > 0) this.keyLabels.clear()
      return false
    }
    return this.keyLabels.has(String(label || '').toLowerCase())
  }

  beginMouse(windowMs = DEFAULT_PASSTHROUGH_WINDOW_MS): void {
    this.mouseExpireAt = this.now() + windowMs
  }

  matchMouse(): boolean {
    return this.now() <= this.mouseExpireAt
  }
}
