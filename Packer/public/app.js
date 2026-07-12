const form = document.getElementById('packerForm')
const baseUrl = document.getElementById('baseUrl')
const apiKey = document.getElementById('apiKey')
const model = document.getElementById('model')
const displayName = document.getElementById('displayName')
const packageSuffix = document.getElementById('packageSuffix')
const runtimeRoot = document.getElementById('runtimeRoot')
const allowSlim = document.getElementById('allowSlim')
const runtimeStatus = document.getElementById('runtimeStatus')
const button = document.getElementById('submitButton')
const logOutput = document.getElementById('logOutput')
const result = document.getElementById('result')
const statusPill = document.getElementById('statusPill')
const outputPreview = document.getElementById('outputPreview')

const fields = [baseUrl, apiKey, model, displayName, packageSuffix, runtimeRoot, allowSlim]
let appVersion = '…'
let productName = 'Ready'
let packageArch = 'arm64'
let defaultArtifactName = ''
let detectedRuntimeRoot = ''

function setStatus(text, state = '') {
  statusPill.textContent = text
  statusPill.dataset.state = state
}

function appendLog(message) {
  if (logOutput.textContent === '等待开始...') logOutput.textContent = ''
  logOutput.textContent += `${message}\n`
  logOutput.scrollTop = logOutput.scrollHeight
}

function setBusy(busy) {
  button.disabled = busy
  for (const field of fields) field.disabled = busy
  button.textContent = busy ? '打包中...' : '确认打包'
}

// Mirror server-side normalizePackageSuffix so the preview matches the real output name.
function normalizeSuffix(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw
    .replace(/\.dmg$/i, '')
    .trim()
    .normalize('NFKC')
    .replace(/[/\\:]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function updatePreview() {
  const suffix = normalizeSuffix(packageSuffix.value)
  outputPreview.textContent = suffix ? `${productName}-${suffix}.dmg` : (defaultArtifactName || `${productName}-${appVersion}-${packageArch}.dmg`)
}

packageSuffix.addEventListener('input', updatePreview)

function setRuntimeStatus(ready, path) {
  if (allowSlim.checked) {
    runtimeStatus.dataset.state = 'ok'
    runtimeStatus.textContent = '默认生成精简包：不内置技能运行时，体积接近 ready-pack；需要完整包时取消勾选。'
  } else if (ready) {
    runtimeStatus.dataset.state = 'ok'
    runtimeStatus.textContent = `✓ 已检测到技能运行时，将生成完整包：${path}`
  } else {
    runtimeStatus.dataset.state = 'warn'
    runtimeStatus.textContent = '未检测到技能运行时。填入 skill-runtime 目录以生成完整包，或勾选“生成精简包”。'
  }
}

async function loadDefaults() {
  try {
    const response = await fetch('/api/defaults')
    if (!response.ok) return
    const defaults = await response.json()
    appVersion = defaults.version || appVersion
    productName = defaults.productName || productName
    packageArch = defaults.arch || packageArch
    defaultArtifactName = defaults.artifactName || ''
    if (defaults.baseUrl) baseUrl.value = defaults.baseUrl
    if (defaults.model) model.value = defaults.model
    if (defaults.displayName) displayName.value = defaults.displayName
    detectedRuntimeRoot = defaults.runtimeRoot || ''
    setRuntimeStatus(Boolean(defaults.runtimeReady), detectedRuntimeRoot)
  } catch {
    // Non-fatal: placeholders already carry the NovaCode defaults.
  } finally {
    updatePreview()
  }
}

loadDefaults()

allowSlim.addEventListener('change', () => {
  if (allowSlim.checked) {
    runtimeRoot.value = ''
  } else if (!runtimeRoot.value && detectedRuntimeRoot) {
    runtimeRoot.value = detectedRuntimeRoot
  }
  setRuntimeStatus(Boolean(detectedRuntimeRoot), detectedRuntimeRoot)
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  result.hidden = true
  logOutput.textContent = ''
  setBusy(true)
  setStatus('打包中', 'running')

  try {
    const response = await fetch('/api/package', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        model: model.value,
        displayName: displayName.value,
        packageSuffix: packageSuffix.value,
        runtimeRoot: runtimeRoot.value,
        allowSlim: allowSlim.checked,
      }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '打包任务创建失败')

    const events = new EventSource(`/api/jobs/${payload.id}/events`)
    events.addEventListener('log', (message) => {
      const item = JSON.parse(message.data)
      appendLog(item.message)
    })
    events.addEventListener('status', (message) => {
      const job = JSON.parse(message.data)
      if (job.status === 'done') {
        events.close()
        setBusy(false)
        setStatus('完成', 'done')
        result.hidden = false
        result.dataset.state = 'done'
        result.textContent = `输出文件：${job.outputPath}`
      } else if (job.status === 'failed') {
        events.close()
        setBusy(false)
        setStatus('失败', 'failed')
        result.hidden = false
        result.dataset.state = 'failed'
        result.textContent = job.error || '打包失败'
      }
    })
    events.onerror = () => {
      appendLog('日志连接已断开，请刷新任务状态。')
    }
  } catch (error) {
    setBusy(false)
    setStatus('失败', 'failed')
    result.hidden = false
    result.dataset.state = 'failed'
    result.textContent = error && error.message ? error.message : String(error)
  }
})
