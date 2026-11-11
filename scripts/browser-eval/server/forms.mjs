import { template, escapeHtml } from './html.mjs'

function wizardPage(step, token, data, error = '') {
  const labels = { name: '姓名', phone: '手机', city: '城市', address: '地址', slot: '时段' }
  return template(`wizard/step${step}.html`, {
    token: escapeHtml(token),
    error: error ? template('wizard/error.html', { error: escapeHtml(error) }) : '',
    name: escapeHtml(data.name),
    phone: escapeHtml(data.phone),
    address: escapeHtml(data.address),
    city0: data.city === '上海' ? 'selected' : '',
    city1: data.city === '北京' ? 'selected' : '',
    city2: data.city === '杭州' ? 'selected' : '',
    slot0: data.slot === '上午' ? 'selected' : '',
    slot1: data.slot === '下午' ? 'selected' : '',
    slot2: data.slot === '晚上' ? 'selected' : '',
    details: Object.entries(data)
      .map(([key, value]) => `<dt>${labels[key]}</dt><dd>${escapeHtml(value)}</dd>`)
      .join(''),
  })
}
export function routeForms(c) {
  const { path, req, fields, state, html, redirect, record, url } = c
  if (path === '/form/') {
    html(template('form/index.html'))
  } else if (path === '/form/submit' && req.method === 'POST') {
    if (!fields.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email || ''))
      return c.send(400, '请填写姓名和有效邮箱')
    const event = record('form.submit', {
      name: fields.name,
      email: fields.email,
      topic: fields.topic || '',
      message: fields.message || '',
      subscribe: fields.subscribe === 'yes',
    })
    redirect(`/form/done?id=${event.seq}`)
  } else if (path === '/form/done') {
    const data = c
      .records()
      .find(r => r.seq === Number(url.searchParams.get('id')) && r.kind === 'form.submit')?.data
    if (!data) return c.send(404, '留言不存在')
    html(
      template('form/done.html', {
        name: escapeHtml(data.name),
        details: escapeHtml(JSON.stringify(data, null, 2)),
      }),
    )
  } else if (path === '/wizard/') {
    const token = `wizard-${++state.wizardSeq}`
    state.wizards.set(token, { step: 1, data: {} })
    html(wizardPage(1, token, {}))
  } else if (path.startsWith('/wizard/')) {
    const token = fields.token || url.searchParams.get('token')
    const entry = state.wizards.get(token)
    if (!entry) return c.send(400, '无效订单会话')
    if (req.method === 'GET') {
      const step = Number(/step([23])$/.exec(path)?.[1])
      if (!step || entry.step !== step) return c.send(409, '订单步骤不正确')
      html(wizardPage(step, token, entry.data))
    } else if (path === '/wizard/step2' && entry.step === 1) {
      const data = { name: fields.name || '', phone: fields.phone || '' }
      if (!/^1\d{10}$/.test(data.phone)) return html(wizardPage(1, token, data, '手机号格式不正确'))
      entry.data = data
      entry.step = 2
      redirect(`/wizard/step2?token=${token}`)
    } else if (path === '/wizard/step3' && entry.step === 2) {
      const data = {
        ...entry.data,
        city: fields.city,
        address: fields.address || '',
        slot: fields.slot,
      }
      if (!data.address.trim()) return html(wizardPage(2, token, data, '请填写地址'))
      if (
        !['上海', '北京', '杭州'].includes(data.city) ||
        !['上午', '下午', '晚上'].includes(data.slot)
      )
        return c.send(400, '配送选项不正确')
      entry.data = data
      entry.step = 3
      redirect(`/wizard/step3?token=${token}`)
    } else if (path === '/wizard/submit' && entry.step === 3) {
      if (fields.agree !== 'yes') return html(wizardPage(3, token, entry.data, '请先确认信息'))
      const orderId = `W-${String(++state.orderSeq).padStart(4, '0')}`
      record('wizard.order', { orderId, ...entry.data })
      entry.step = 4
      html(
        template('wizard/done.html', {
          orderId: orderId,
        }),
      )
    } else c.send(409, '订单步骤不正确')
  } else return false
  return true
}
