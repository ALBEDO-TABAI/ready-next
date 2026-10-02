const CDN_WHITELIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
] as const

/**
 * W10c（2026-07-11 dogfood）：index.html CSP 的 script-src 同时声明 nonce 与
 * 'unsafe-inline'——按 CSP 规范 nonce 在场时 'unsafe-inline' 被忽略，因此所有
 * 未盖 nonce 的内联脚本（含 srcdoc iframe 继承宿主 CSP 后的接收器脚本）都被
 * 静默拦截，widget:ready 永远不来，交互预览恒降级为静态回退。此常量必须与
 * index.html CSP 中的 'nonce-…' 逐字一致（一致性由 widget-script-nonce 合同
 * 测试钉住），并盖到接收器脚本与所有经净化的 widget 内联脚本上。
 */
export const WIDGET_SCRIPT_NONCE = 'cmVhZHktd2lkZ2V0'

const DANGEROUS_BLOCK_TAGS = /<(iframe|object|embed|form|meta|link|base)[\s>][\s\S]*?<\/\1>/gi
const DANGEROUS_VOID_TAGS = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi
const SCRIPT_TAG_REGEX = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const EVENT_HANDLER_ATTR_REGEX = /\s+(on[a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi
const READY_HANDLER_ATTR_REGEX = /\s+data-ready-on(?:click|input|change)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+)/gi
const SUPPORTED_EVENT_HANDLERS = new Set(['onclick', 'oninput', 'onchange'])
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

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function rewriteSupportedEventHandlers(html: string): string {
  return html.replace(EVENT_HANDLER_ATTR_REGEX, (_match, rawName: string, dq?: string, sq?: string, uq?: string) => {
    const name = rawName.toLowerCase()
    if (!SUPPORTED_EVENT_HANDLERS.has(name)) return ''
    const value = dq ?? sq ?? uq ?? ''
    return ` data-ready-${name}="${escapeAttributeValue(value)}"`
  })
}

export function sanitizeWidgetHtml(html: string): string {
  const withoutDangerousTags = html
    .replace(DANGEROUS_BLOCK_TAGS, '')
    .replace(DANGEROUS_VOID_TAGS, '')

  const scriptSlots: string[] = []
  const markupWithScriptSlots = withoutDangerousTags.replace(SCRIPT_TAG_REGEX, (_match, attrs: string, body: string) => {
    const srcMatch = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/i)
    const src = (srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '').trim()
    let safeScript = ''

    if (src) {
      if (!isWhitelistedScriptSrc(src)) return ''
      const moduleType = /\stype\s*=\s*(?:"module"|'module'|module)(?=\s|$)/i.test(attrs)
      const asyncAttr = /\sasync(?:\s|=|$)/i.test(attrs)
      const deferAttr = /\sdefer(?:\s|=|$)/i.test(attrs)
      safeScript = `<script${moduleType ? ' type="module"' : ''} src="${escapeAttributeValue(src)}"${asyncAttr ? ' async' : ''}${deferAttr ? ' defer' : ''} nonce="${WIDGET_SCRIPT_NONCE}"></script>`
    } else {
      safeScript = `<script nonce="${WIDGET_SCRIPT_NONCE}">${body}</script>`
    }

    const index = scriptSlots.push(safeScript) - 1
    return `<!--ready-widget-script-slot:${index}-->`
  })

  const safeMarkup = sanitizeDangerousUrls(rewriteSupportedEventHandlers(markupWithScriptSlots))
  return safeMarkup.replace(/<!--ready-widget-script-slot:(\d+)-->/g, (match, rawIndex: string) => (
    scriptSlots[Number(rawIndex)] ?? match
  ))
}

export function stripWidgetScripts(html: string): string {
  return sanitizeDangerousUrls(
    html
      .replace(SCRIPT_TAG_REGEX, '')
      .replace(EVENT_HANDLER_ATTR_REGEX, '')
      .replace(READY_HANDLER_ATTR_REGEX, ''),
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
  const animationHostStub = `if(typeof window.__widgetRender!=='function'){window.__widgetRender=function(){};}if(typeof window.__widgetFrame!=='function'){window.__widgetFrame=function(){};}`
  const receiverScript = `(function(){
try {
${animationHostStub}
var widgetToken='${safeToken}';
var root=document.getElementById('__widget-root');
var resizeTimer=null;
var stateTimer=null;
function collectWidgetState(){
  var controls=Array.from(document.querySelectorAll('input, textarea, select')).map(function(element,index){
    var tag=element.tagName.toLowerCase();
    if(element instanceof HTMLInputElement){
      return {index:index,tag:'input',type:element.type||'text',value:element.value,checked:element.checked};
    }
    if(element instanceof HTMLTextAreaElement){
      return {index:index,tag:'textarea',value:element.value};
    }
    if(element instanceof HTMLSelectElement){
      return {index:index,tag:'select',value:element.value};
    }
    return {index:index,tag:tag,value:''};
  });
  var activeTargets=Array.from(document.querySelectorAll('[data-tab-target].is-active, [data-focus-target].is-active')).map(function(element){
    if(!(element instanceof HTMLElement)) return null;
    var tabTarget=element.getAttribute('data-tab-target');
    if(tabTarget) return {attr:'data-tab-target',value:tabTarget};
    var focusTarget=element.getAttribute('data-focus-target');
    if(focusTarget) return {attr:'data-focus-target',value:focusTarget};
    return null;
  }).filter(Boolean);
  return {controls:controls,activeTargets:activeTargets};
}
function notifyState(){
  if(stateTimer) clearTimeout(stateTimer);
  stateTimer=setTimeout(function(){
    parent.postMessage({type:'widget:state',state:collectWidgetState(),token:widgetToken},'*');
  },20);
}
function applyWidgetState(state){
  if(!state || typeof state !== 'object') return;
  var controls=Array.from(document.querySelectorAll('input, textarea, select'));
  Array.from(state.controls || []).forEach(function(controlState){
    if(!controlState || typeof controlState.index !== 'number') return;
    var element=controls[controlState.index];
    if(!element) return;
    if(element instanceof HTMLInputElement){
      if(typeof controlState.checked === 'boolean' && (controlState.type === 'checkbox' || controlState.type === 'radio' || element.type === 'checkbox' || element.type === 'radio')){
        element.checked=controlState.checked;
      }
      if(typeof controlState.value === 'string'){
        element.value=controlState.value;
      }
      element.dispatchEvent(new Event('input',{bubbles:true}));
      element.dispatchEvent(new Event('change',{bubbles:true}));
      return;
    }
    if((element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && typeof controlState.value === 'string'){
      element.value=controlState.value;
      element.dispatchEvent(new Event('input',{bubbles:true}));
      element.dispatchEvent(new Event('change',{bubbles:true}));
    }
  });
  Array.from(state.activeTargets || []).forEach(function(activeTarget){
    if(!activeTarget || !activeTarget.attr || !activeTarget.value) return;
    var selector='[' + activeTarget.attr + '="' + String(activeTarget.value).replace(/"/g,'\\"') + '"]';
    var element=document.querySelector(selector);
    if(element instanceof HTMLElement && !element.classList.contains('is-active')){
      element.click();
    }
  });
}
function invokeInlineHandler(target, attrName, event){
  if(!target || typeof target.getAttribute !== 'function') return false;
  var expr=String(target.getAttribute('data-ready-' + attrName) || '').trim();
  if(!expr) return false;
  var match=expr.match(/^(?:return\\s+)?(?:window\\.)?([A-Za-z_$][\\w$]*)\\(([\\s\\S]*)\\)\\s*;?$/);
  if(!match || !match[1]) return false;
  var fn=window[match[1]];
  if(typeof fn !== 'function') return false;
  var rawArgs=String(match[2] || '').trim();
  var argTokens=[];
  if(rawArgs){
    var current='';
    var quote='';
    var escaped=false;
    for(var i=0;i<rawArgs.length;i+=1){
      var ch=rawArgs.charAt(i);
      if(escaped){current+=ch;escaped=false;continue;}
      if(ch==='\\\\'){current+=ch;escaped=true;continue;}
      if(quote){current+=ch;if(ch===quote) quote='';continue;}
      if(ch==='"' || ch==="'"){quote=ch;current+=ch;continue;}
      if(ch===','){argTokens.push(current.trim());current='';continue;}
      current+=ch;
    }
    if(quote || escaped) return false;
    argTokens.push(current.trim());
  }
  var args=[];
  for(var j=0;j<argTokens.length;j+=1){
    var raw=argTokens[j];
    if(raw==='event'){args.push(event);continue;}
    if(raw==='this'){args.push(target);continue;}
    if(raw==='this.value'){args.push(target && 'value' in target ? target.value : undefined);continue;}
    if(raw==='event.target.value'){args.push(event && event.target ? event.target.value : undefined);continue;}
    if(raw==='true' || raw==='false'){args.push(raw==='true');continue;}
    if(raw==='null'){args.push(null);continue;}
    if(/^-?(?:\\d+\\.?\\d*|\\.\\d+)$/.test(raw)){args.push(Number(raw));continue;}
    var first=raw.charAt(0);
    var last=raw.charAt(raw.length-1);
    if((first==='"' && last==='"') || (first==="'" && last==="'")){args.push(raw.slice(1,-1));continue;}
    return false;
  }
  var result=fn.apply(target,args);
  if(result===false && event){
    if(typeof event.preventDefault==='function') event.preventDefault();
    if(typeof event.stopPropagation==='function') event.stopPropagation();
  }
  return true;
}
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
  var messageNode=event.target && event.target.closest ? event.target.closest('[data-ready-agent-message]') : null;
  if(messageNode){
    var widgetMessage = messageNode.getAttribute('data-ready-agent-message');
    if(widgetMessage){
      event.preventDefault();
      parent.postMessage({type:'widget:message',text:String(widgetMessage),token:widgetToken},'*');
      return;
    }
  }
  var inlineClickNode=event.target && event.target.closest ? event.target.closest('[data-ready-onclick]') : null;
  var inlineClickHandled=invokeInlineHandler(inlineClickNode, 'onclick', event);
  if(inlineClickHandled && event.defaultPrevented) return;
  var link=event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if(!link) return;
  var href=link.getAttribute('href');
  if(!href || /^\\s*javascript\\s*:/i.test(href)) return;
  event.preventDefault();
  parent.postMessage({type:'widget:link',href:href,token:widgetToken},'*');
  return;
});
document.addEventListener('click',function(){
  window.setTimeout(notifyState,0);
});
window.__readyWidgetSendMessage=function(text){
  if(typeof text !== 'string') return;
  var trimmed = text.trim();
  if(!trimmed) return;
  parent.postMessage({type:'widget:message',text:trimmed,token:widgetToken},'*');
};
document.addEventListener('input',function(event){
  clampNumericInput(event.target);
  invokeInlineHandler(event.target, 'oninput', event);
  window.setTimeout(notifyState,0);
}, true);
document.addEventListener('change',function(event){
  clampNumericInput(event.target);
  invokeInlineHandler(event.target, 'onchange', event);
  window.setTimeout(notifyState,0);
}, true);

window.addEventListener('message',function(event){
  if(!event.data || typeof event.data.type!=='string') return;
  if(event.data.token && event.data.token!==widgetToken) return;
  if(event.data.type==='widget:theme'){
    var vars=event.data.vars || {};
    Object.keys(vars).forEach(function(key){
      document.documentElement.style.setProperty(key, String(vars[key]));
    });
    document.documentElement.className=event.data.isDark ? 'dark' : '';
    // 与宿主 color-scheme 保持一致：不一致时 Chromium 会给 iframe 铺不透明底色，圆角处露出白/黑边
    document.documentElement.style.colorScheme=event.data.isDark ? 'dark' : 'light dark';
    notifyResize();
    return;
  }
  if(event.data.type==='widget:hydrate'){
    applyWidgetState(event.data.state);
    window.setTimeout(function(){
      notifyResize();
      notifyState();
    },0);
  }
});

setTimeout(function(){
  parent.postMessage({type:'widget:ready',token:widgetToken},'*');
  notifyResize();
  notifyState();
}, 30);
} catch (error) {
  parent.postMessage({type:'widget:error',message:String(error && error.message ? error.message : error),token:widgetToken},'*');
}
})();`

  return `<!doctype html>
<html class="${isDark ? 'dark' : ''}" style="color-scheme:${isDark ? 'dark' : 'light dark'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${styleBlock}</style>
</head>
<body style="margin:0;padding:0;background:transparent;" data-widget-token="${safeToken}">
  <div id="__widget-root"><div class="widget-root">${safeInitialHtml}</div></div>
  <script nonce="${WIDGET_SCRIPT_NONCE}">${receiverScript}</script>
</body>
</html>`
}
