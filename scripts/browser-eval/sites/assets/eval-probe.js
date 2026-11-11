const types = [
  'pointerdown',
  'mousedown',
  'click',
  'keydown',
  'input',
  'change',
  'submit',
  'wheel',
  'scroll',
]
window.__evalProbe = {
  counts: Object.fromEntries(types.map(type => [type, 0])),
  lastClick: null,
  lastKey: null,
  trusted: { click: 0, keydown: 0, input: 0 },
}
for (const type of types)
  document.addEventListener(
    type,
    event => {
      const probe = window.__evalProbe
      probe.counts[type]++
      if (type === 'click') {
        const target = event.target instanceof Element ? event.target : event.target.parentElement
        const identified = target?.closest('[id]')
        probe.lastClick = identified ? `#${identified.id}` : target?.tagName.toLowerCase() || null
      }
      if (type === 'keydown') probe.lastKey = event.key
      if (event.isTrusted && type in probe.trusted) probe.trusted[type]++
    },
    true,
  )
