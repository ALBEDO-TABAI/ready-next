import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Loader2, QrCode } from 'lucide-react'
import { Button, Input } from '../ui'

type LoginState = { sessionKey?: string; status?: string; message?: string; qrcodeUrl?: string }
const pendingStates = new Set(['preparing', 'waiting', 'scanned', 'needs_verify_code', 'activating'])

export function WechatLoginControl({ channelId, enabled, disabled, beforeStart, onChanged }: {
  channelId: string
  enabled: boolean
  disabled: boolean
  beforeStart: () => Promise<void>
  onChanged: () => Promise<void>
}) {
  const [login, setLogin] = useState<LoginState | null>(null)
  const [qrImage, setQrImage] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'start' | 'cancel' | 'verify' | null>(null)
  const callbacks = useRef({ beforeStart, onChanged })
  callbacks.current = { beforeStart, onChanged }
  const mounted = useRef(true)
  const generation = useRef(0)
  const action = useRef<string | null>(null)
  const previousStatus = useRef('')

  const refresh = useCallback(async () => {
    const version = generation.current
    try {
      const result = await window.electronAPI.agent.getWechatLoginStatus({ channelId })
      if (!mounted.current || version !== generation.current) return
      if (!result.success || !result.data) {
        setLogin({ status: 'error' })
        setError(result.error || '无法读取微信绑定状态，请重试。')
        return
      }
      const current = result.data
      setLogin(current)
      if (current.status !== previousStatus.current) setError('')
      if (current.status === 'connected' && previousStatus.current !== 'connected') await callbacks.current.onChanged()
      previousStatus.current = current.status || ''
    } catch (error) {
      if (mounted.current && version === generation.current) setError(error instanceof Error ? error.message : '无法读取微信绑定状态')
    }
  }, [channelId])

  useEffect(() => {
    mounted.current = true
    let reading = false
    const poll = async () => {
      if (reading) return
      reading = true
      try { await refresh() } finally { reading = false }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1500)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a request counter, not a DOM node; cleanup bumps its latest value so in-flight status reads and login actions are dropped
    return () => { mounted.current = false; ++generation.current; window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    let disposed = false
    setQrImage('')
    if (login?.qrcodeUrl && pendingStates.has(login.status || '')) {
      const url = login.qrcodeUrl
      void (url.startsWith('data:image/') ? Promise.resolve(url) : QRCode.toDataURL(url, { width: 240, margin: 1 }))
        .then(image => { if (!disposed) setQrImage(image) })
        .catch(() => { if (!disposed) setError('二维码显示失败，请重新生成。') })
    }
    return () => { disposed = true }
  }, [login?.qrcodeUrl, login?.status])

  const start = async () => {
    if (action.current) return
    const version = ++generation.current
    action.current = 'start'
    setBusy('start'); setError(''); setCode('')
    setLogin({ status: 'preparing', message: '正在准备微信连接并获取二维码…' })
    try {
      await callbacks.current.beforeStart()
      if (!mounted.current || version !== generation.current) return
      const result = await window.electronAPI.agent.startWechatLogin({ id: channelId, force: true })
      if (!mounted.current || version !== generation.current) return
      if (!result.success || !result.data) throw new Error(result.error || '无法生成微信二维码，请重试。')
      if (!result.data.sessionKey || !result.data.qrcodeUrl) throw new Error('微信没有返回有效二维码，请重试。')
      setLogin(result.data)
    } catch (error) {
      if (mounted.current && version === generation.current) {
        setLogin({ status: 'error' }); setError(error instanceof Error ? error.message : '微信连接失败')
      }
    } finally {
      if (version === generation.current) { action.current = null; if (mounted.current) setBusy(null) }
    }
  }

  const cancel = async () => {
    if (action.current === 'cancel') return
    ++generation.current
    action.current = 'cancel'; setBusy('cancel'); setError('')
    let failure = ''
    try {
      const result = await window.electronAPI.agent.setChannelEnabled(channelId, false)
      if (!result.success) throw new Error(result.error || '取消失败，请重试。')
      if (mounted.current) setLogin({ status: 'idle', message: '已取消绑定，可以重新开始。' })
      await callbacks.current.onChanged()
    } catch (error) {
      // silent-catch: the message is shown after the refresh in finally
      failure = error instanceof Error ? error.message : '取消失败'
    }
    finally { action.current = null; if (mounted.current) { setBusy(null); await refresh(); if (failure) setError(failure) } }
  }

  const verify = async () => {
    if (action.current || !login?.sessionKey || !code.trim()) return
    action.current = 'verify'; setBusy('verify')
    try {
      const result = await window.electronAPI.agent.submitWechatLoginVerifyCode({ channelId, sessionKey: login.sessionKey, code })
      if (!result.success) throw new Error(result.error || '验证码提交失败')
      await refresh()
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '验证码提交失败') }
    finally { action.current = null; if (mounted.current) setBusy(null) }
  }

  const pending = pendingStates.has(login?.status || '') || busy === 'start'
  const spinning = busy !== null || login?.status === 'preparing' || login?.status === 'activating'
  const message = busy === 'cancel' ? '正在取消绑定…' : login?.status === 'connected' ? '微信已绑定，可以发送任务或测试消息。' : login?.message
  return (
    <div className="flex w-full flex-col" style={{ gap: 12 }}>
      <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
        <Button variant="primary" disabled={disabled || pending || busy !== null || login === null} onClick={() => void start()}
          icon={spinning ? <Loader2 className="animate-spin" /> : <QrCode />}>
          {pending ? '绑定进行中' : enabled ? '重新绑定' : '生成绑定二维码'}
        </Button>
        {pending && <Button disabled={busy === 'cancel' || login?.status === 'activating'} onClick={() => void cancel()}>取消绑定</Button>}
        {!login && error && <Button variant="ghost" onClick={() => void refresh()}>重新读取状态</Button>}
      </div>
      {/* 二维码底永远是浅色的纸（data-theme="light" 取浅色令牌），深色主题下也要能被手机扫到。 */}
      {qrImage && <div className="self-start" data-theme="light"
        style={{ padding: 14, borderRadius: 16, background: 'var(--rn-sheet)', boxShadow: 'var(--rn-card-shadow)' }}>
        <img src={qrImage} alt="微信绑定二维码" width={208} height={208} style={{ display: 'block', imageRendering: 'pixelated' }} />
      </div>}
      {message && <div role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-[12px] leading-6"
        style={{ color: login?.status === 'connected' ? 'var(--rn-ink)' : 'var(--rn-ink-2)' }}>
        {login?.status === 'connected' && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} />}
        {message}
      </div>}
      {login?.status === 'needs_verify_code' && <div className="flex items-center gap-2">
        <Input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" placeholder="输入手机微信显示的数字"
          aria-label="微信验证码" className="sx-mono" style={{ width: 240 }} />
        <Button disabled={busy !== null || !code.trim()} onClick={() => void verify()}>提交</Button>
      </div>}
      {error && <div role="alert" className="sx-text-danger text-[12px] leading-6">{error}</div>}
    </div>
  )
}
