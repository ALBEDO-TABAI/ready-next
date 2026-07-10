/**
 * 启动阶段耗时观测：以 process.uptime()（主进程自 spawn 起的秒数）为统一时间轴，
 * 量化「进程启动 → app ready → splash 可见 → 重模块加载完成 → 主窗口可见」。
 * 只写 console，dev 终端与打包后的 stdout 都能看到，不落文件。
 */
let lastStage = 'process-start'

export function logBootStage(stage: string): void {
  lastStage = stage
  console.log(`[boot-timing] ${stage} +${process.uptime().toFixed(2)}s`)
}

/**
 * 启动期主线程卡顿探针：32ms 心跳，漂移 >150ms 即视为一次实心阻塞，
 * 记录发生在哪个 boot 阶段之后、卡了多久。splash 动画冻结与这些阻塞
 * 一一对应（新窗口帧呈现耦合主线程活性），这是定位"该给哪一步加
 * yieldToPresentation / 异步化"的唯一可靠地图。启动 30s 后自动停止。
 */
export function startBootStallProbe(): void {
  const HEARTBEAT_MS = 32
  const STALL_THRESHOLD_MS = 150
  const PROBE_LIFETIME_MS = 30_000
  let lastBeat = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const drift = now - lastBeat - HEARTBEAT_MS
    if (drift > STALL_THRESHOLD_MS) {
      console.log(`[boot-stall] ~${drift}ms blocked after "${lastStage}" (+${process.uptime().toFixed(2)}s)`)
    }
    lastBeat = now
  }, HEARTBEAT_MS)
  setTimeout(() => clearInterval(timer), PROBE_LIFETIME_MS)
}
