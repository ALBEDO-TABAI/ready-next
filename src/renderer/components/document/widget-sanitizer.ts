const CDN_WHITELIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
] as const

const DANGEROUS_BLOCK_TAGS = /<(iframe|object|embed|form|meta|link|base)[\s>][\s\S]*?<\/\1>/gi
const DANGEROUS_VOID_TAGS = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi
const SCRIPT_TAG_REGEX = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const EVENT_HANDLER_ATTR_REGEX = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi
function isWhitelistedScriptSrc(src: string): boolean {
  try {
    const url = new URL(src)
    return CDN_WHITELIST.includes(url.hostname as (typeof CDN_WHITELIST)[number])
  } catch {
    return false
  }
}

function sanitizeDangerousUrls(html: string): string {
  return html.replace(
    /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi,
    (match, _attr: string, dq?: string, sq?: string, uq?: string) => {
      const url = (dq ?? sq ?? uq ?? '').trim()
      if (/^\s*javascript\s*:/i.test(url)) return ''
      return match
    },
  )
}

export function sanitizeWidgetHtml(html: string): string {
  const withoutDangerousTags = html
    .replace(DANGEROUS_BLOCK_TAGS, '')
    .replace(DANGEROUS_VOID_TAGS, '')

  const safeScripts = withoutDangerousTags.replace(SCRIPT_TAG_REGEX, (_match, attrs: string, body: string) => {
    const srcMatch = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/i)
    const src = (srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '').trim()

    if (src) {
      return isWhitelistedScriptSrc(src) ? `<script${attrs}></script>` : ''
    }

    return `<script>${body}</script>`
  })

  return sanitizeDangerousUrls(safeScripts)
}

export function stripWidgetScripts(html: string): string {
  return sanitizeDangerousUrls(
    html
      .replace(SCRIPT_TAG_REGEX, '')
      .replace(EVENT_HANDLER_ATTR_REGEX, ''),
  )
}

export function widgetHtmlNeedsSandbox(html: string): boolean {
  return html.trim().length > 0
}

function escapeHtmlForTemplate(html: string): string {
  return html.replace(/<\/template/gi, '<\\/template')
}

function escapeInlineJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

export function buildWidgetReceiverSrcdoc(
  styleBlock: string,
  isDark: boolean,
  initialHtml: string,
  token: string,
): string {
  const safeInitialHtml = escapeHtmlForTemplate(initialHtml)
  const safeToken = escapeInlineJsString(token)
  const receiverScript = `(function(){
try {
var widgetToken='${safeToken}';
var root=document.getElementById('__widget-root');
var resizeTimer=null;
function notifyResize(){
  if(resizeTimer) clearTimeout(resizeTimer);
  resizeTimer=setTimeout(function(){
    var h=Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    parent.postMessage({type:'widget:resize',height:h,token:widgetToken},'*');
  },30);
}
function clampNumericInput(target){
  if(!(target instanceof HTMLInputElement)) return;
  if(target.type !== 'number') return;
  var value = String(target.value || '').trim();
  if(!value) return;
  var numeric = Number(value);
  if(!isFinite(numeric)) return;
  var minAttr = target.getAttribute('min');
  var maxAttr = target.getAttribute('max');
  if(minAttr != null && minAttr !== ''){
    var min = Number(minAttr);
    if(isFinite(min)) numeric = Math.max(numeric, min);
  }
  if(maxAttr != null && maxAttr !== ''){
    var max = Number(maxAttr);
    if(isFinite(max)) numeric = Math.min(numeric, max);
  }
  target.value = String(numeric);
}
if (typeof ResizeObserver === 'function') {
  var observer=new ResizeObserver(notifyResize);
  observer.observe(document.body);
} else {
  window.addEventListener('resize', notifyResize);
  window.addEventListener('load', notifyResize);
  document.addEventListener('DOMContentLoaded', notifyResize);
}

document.addEventListener('click',function(event){
  var link=event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if(!link) return;
  var href=link.getAttribute('href');
  if(!href || /^\\s*javascript\\s*:/i.test(href)) return;
  event.preventDefault();
  parent.postMessage({type:'widget:link',href:href,token:widgetToken},'*');
});
document.addEventListener('input',function(event){
  clampNumericInput(event.target);
}, true);
document.addEventListener('change',function(event){
  clampNumericInput(event.target);
}, true);

window.addEventListener('message',function(event){
  if(!event.data || typeof event.data.type!=='string') return;
  if(event.data.type==='widget:theme'){
    var vars=event.data.vars || {};
    Object.keys(vars).forEach(function(key){
      document.documentElement.style.setProperty(key, String(vars[key]));
    });
    document.documentElement.className=event.data.isDark ? 'dark' : '';
    notifyResize();
  }
});

setTimeout(function(){
  parent.postMessage({type:'widget:ready',token:widgetToken},'*');
  notifyResize();
}, 30);
} catch (error) {
  parent.postMessage({type:'widget:error',message:String(error && error.message ? error.message : error),token:widgetToken},'*');
}
})();`

  return `<!doctype html>
<html class="${isDark ? 'dark' : ''}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${styleBlock}</style>
</head>
<body style="margin:0;padding:0;background:transparent;" data-widget-token="${safeToken}">
  <div id="__widget-root"><div class="widget-root">${safeInitialHtml}</div></div>
  <script>${receiverScript}</script>
</body>
</html>`
}
