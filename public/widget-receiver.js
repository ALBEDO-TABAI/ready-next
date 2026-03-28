(function () {
  try {
    var root = document.getElementById('__widget-root')
    var template = document.getElementById('__widget-template')
    var widgetToken = document.body.getAttribute('data-widget-token') || ''
    var resizeTimer = null

    function notifyResize() {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(function () {
        var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        parent.postMessage({ type: 'widget:resize', height: h, token: widgetToken }, '*')
      }, 30)
    }

    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(notifyResize)
      observer.observe(document.body)
    } else {
      window.addEventListener('resize', notifyResize)
      window.addEventListener('load', notifyResize)
      document.addEventListener('DOMContentLoaded', notifyResize)
    }

    function executeScripts(container) {
      var scripts = container.querySelectorAll('script')
      var chain = Promise.resolve()
      scripts.forEach(function (oldScript) {
        chain = chain.then(function () {
          return new Promise(function (resolve) {
            var next = document.createElement('script')
            Array.from(oldScript.attributes).forEach(function (attr) {
              next.setAttribute(attr.name, attr.value)
            })
            if (oldScript.src) {
              next.onload = function () { resolve(undefined) }
              next.onerror = function () { resolve(undefined) }
            }
            if (!oldScript.src) {
              next.textContent = oldScript.textContent
            }
            oldScript.replaceWith(next)
            if (!oldScript.src) {
              resolve(undefined)
            }
          })
        })
      })
      return chain
    }

    function renderHtml(html) {
      root.innerHTML = '<div class="widget-root">' + html + '</div>'
      executeScripts(root)
        .then(function () { notifyResize() })
        .catch(function (error) {
          parent.postMessage({ type: 'widget:error', message: String(error && error.message ? error.message : error), token: widgetToken }, '*')
          notifyResize()
        })
    }

    document.addEventListener('click', function (event) {
      var target = event.target
      var link = target && target.closest ? target.closest('a[href]') : null
      if (!link) return
      var href = link.getAttribute('href')
      if (!href || /^\s*javascript\s*:/i.test(href)) return
      event.preventDefault()
      parent.postMessage({ type: 'widget:link', href: href, token: widgetToken }, '*')
    })

    window.addEventListener('message', function (event) {
      if (!event.data || typeof event.data.type !== 'string') return
      if (event.data.type === 'widget:theme') {
        var vars = event.data.vars || {}
        Object.keys(vars).forEach(function (key) {
          document.documentElement.style.setProperty(key, String(vars[key]))
        })
        document.documentElement.className = event.data.isDark ? 'dark' : ''
        notifyResize()
      }
    })

    renderHtml(template ? template.innerHTML : '')
    parent.postMessage({ type: 'widget:ready', token: widgetToken }, '*')
    notifyResize()
  } catch (error) {
    var token = document.body.getAttribute('data-widget-token') || ''
    parent.postMessage({ type: 'widget:error', message: String(error && error.message ? error.message : error), token: token }, '*')
  }
}())
