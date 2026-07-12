/**
 * 关系图共享渲染器：openui `relationship_graph` 组件与骨架 `relation_map` 的同一实现。
 *
 * 布局哲学：模型只给 groups/nodes/edges，卡片排版与连线端点由 HTML 布局 + 运行时
 * 测量（ResizeObserver + rail 路由）决定，不接受手写坐标。
 *
 * Ready 化纪律：连线的"身份"由标签 chip + 线型 + 图例承担，颜色只作强调
 * （emotion/主角=品牌橘红、alliance=完成绿、其余墨灰阶），无第二 accent、无彩虹；
 * 组色板同理（首组=accent，其余墨阶），模型提供的 group.color 被接受但不参与渲染。
 */

import { z } from 'zod'
import { widgetVar } from './document-widget-theme'

export const relationshipGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().optional(),
  position: z.enum(['center', 'left', 'right', 'top', 'bottom']).optional(),
})

export const relationshipNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  subtitle: z.string().optional(),
  tag: z.string().optional(),
  group: z.string().optional(),
  emphasis: z.enum(['primary', 'secondary', 'muted']).optional(),
})

export const relationshipEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(['emotion', 'family', 'conflict', 'alliance', 'influence', 'other']).optional(),
  style: z.enum(['solid', 'dashed', 'dotted']).optional(),
  weight: z.enum(['light', 'normal', 'heavy']).optional(),
})

export const relationshipGraphPropsSchema = z.object({
  heading: z.string().optional(),
  groups: z.array(relationshipGroupSchema).max(6).optional(),
  nodes: z.array(relationshipNodeSchema).min(2).max(24),
  edges: z.array(relationshipEdgeSchema).min(1).max(40),
  note: z.string().optional(),
})

export type RelationshipGraphProps = z.infer<typeof relationshipGraphPropsSchema>
type RelationshipGroup = z.infer<typeof relationshipGroupSchema>
type RelationshipNode = z.infer<typeof relationshipNodeSchema>
type RelationshipEdgeKind = NonNullable<z.infer<typeof relationshipEdgeSchema>['kind']>

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** 组色板：首组品牌橘红，其余墨阶（代码执掌，忽略模型供色）。 */
function relationshipGroupColor(index: number): string {
  const palette = [
    widgetVar('accent'),
    widgetVar('ink'),
    widgetVar('ink2'),
    widgetVar('ink3'),
    widgetVar('dcOff'),
    widgetVar('dotDim'),
  ]
  return palette[index % palette.length]
}

/** 连线色：颜色只作强调，身份由标签/线型/图例承担。 */
function relationshipEdgeColor(kind: RelationshipEdgeKind | undefined): string {
  switch (kind) {
    case 'emotion':
      return widgetVar('accent')
    case 'alliance':
      return widgetVar('ok')
    case 'family':
      return widgetVar('ink2')
    case 'conflict':
      return widgetVar('ink')
    case 'influence':
      return widgetVar('ink3')
    default:
      return widgetVar('dcOff')
  }
}

/** 无显式线型时按 kind 给默认线型，让身份不只靠颜色。 */
function relationshipEdgeStyle(kind: RelationshipEdgeKind | undefined, style?: string): string {
  if (style === 'solid' || style === 'dashed' || style === 'dotted') return style
  if (kind === 'conflict') return 'dashed'
  if (kind === 'influence') return 'dotted'
  return 'solid'
}

const EDGE_KIND_LABELS: Record<RelationshipEdgeKind, string> = {
  emotion: '情感',
  family: '亲属',
  conflict: '冲突',
  alliance: '同盟',
  influence: '影响',
  other: '其他',
}

function renderHeader(heading?: string): string {
  return heading ? `<div class="title">${escapeHtml(heading)}</div>` : ''
}

export function compileRelationshipGraph(props: RelationshipGraphProps): string {
  type RelationshipGroupWithColor = RelationshipGroup & { color: string }
  type ResolvedRelationshipGroup = RelationshipGroupWithColor & { nodes: RelationshipNode[] }

  const suppliedGroups = props.groups || []
  const nodeGroups = Array.from(new Set(props.nodes.map((node) => node.group).filter((value): value is string => Boolean(value))))
  const groups: RelationshipGroup[] = [
    ...suppliedGroups,
    ...nodeGroups
      .filter((groupId) => !suppliedGroups.some((group) => group.id === groupId))
      .map((groupId) => ({ id: groupId, label: groupId })),
  ]
  const groupsWithFallback: RelationshipGroup[] = groups.length > 0 ? groups : [{ id: 'main', label: '关系网络', position: 'center' }]
  const groupById = new Map<string, RelationshipGroupWithColor>(
    groupsWithFallback.map((group, index) => [group.id, { ...group, color: relationshipGroupColor(index) }] as const),
  )
  const ungroupedId = groupsWithFallback[0]?.id || 'main'
  const groupedNodes: ResolvedRelationshipGroup[] = groupsWithFallback.map((group) => ({
    ...groupById.get(group.id)!,
    nodes: props.nodes.filter((node) => (node.group || ungroupedId) === group.id),
  })).filter((group) => group.nodes.length > 0)
  const knownNodeIds = new Set(props.nodes.map((node) => node.id))
  const invalidEdgeCount = props.edges.filter((edge) => !knownNodeIds.has(edge.from) || !knownNodeIds.has(edge.to)).length
  const edges = props.edges
    .filter((edge) => knownNodeIds.has(edge.from) && knownNodeIds.has(edge.to))
    .map((edge, routeIndex) => ({
      ...edge,
      kind: edge.kind || 'other',
      style: relationshipEdgeStyle(edge.kind, edge.style),
      weight: edge.weight || 'normal',
      color: relationshipEdgeColor(edge.kind),
      routeIndex,
    }))
  const edgeData = escapeJsonForScript(edges)
  const legendKinds = Array.from(new Set(edges.map((edge) => edge.kind)))
  const legend = legendKinds.length
    ? `<div class="rg-legend">${legendKinds.map((kind) => `<span><i style="background:${escapeAttr(relationshipEdgeColor(kind))};"></i>${escapeHtml(EDGE_KIND_LABELS[kind])}</span>`).join('')}</div>`
    : ''
  const warning = invalidEdgeCount > 0
    ? `<div class="rg-warning">有 ${invalidEdgeCount} 条关系引用了不存在的人物，已跳过。</div>`
    : ''
  const note = props.note ? `<div class="rg-note">${escapeHtml(props.note)}</div>` : ''
  const groupsHtml = groupedNodes.map((group) => {
    const position = group.position || 'center'
    return `<section class="rg-group rg-pos-${escapeAttr(position)}" data-rg-group-panel="${escapeAttr(group.id)}" style="--rg-group-color:${escapeAttr(group.color)};">
      <div class="rg-group-label"><span></span>${escapeHtml(group.label)}</div>
      <div class="rg-node-list">
        ${group.nodes.map((node) => `<article class="rg-node rg-node-${escapeAttr(node.emphasis || 'secondary')}" data-rg-node="${escapeAttr(node.id)}" data-rg-group="${escapeAttr(group.id)}" style="--rg-node-color:${escapeAttr(group.color)};">
          <div class="rg-node-title">${escapeHtml(node.label)}</div>
          ${node.subtitle ? `<div class="rg-node-subtitle">${escapeHtml(node.subtitle)}</div>` : ''}
          ${node.tag ? `<div class="rg-node-tag">${escapeHtml(node.tag)}</div>` : ''}
        </article>`).join('')}
      </div>
    </section>`
  }).join('')

  return `<div class="card relationship-graph-widget" data-rg-root>
    <style>
      .relationship-graph-widget{position:relative;overflow:hidden;padding:22px;background:${widgetVar('card')};border:1px solid ${widgetVar('hair')};}
      .relationship-graph-widget .rg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;}
      .relationship-graph-widget .rg-stage{position:relative;min-height:360px;padding:12px 4px 6px;}
      .relationship-graph-widget .rg-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2;}
      .relationship-graph-widget .rg-groups{position:relative;display:grid;grid-template-columns:minmax(150px,1fr) minmax(190px,1.18fr) minmax(150px,1fr);gap:24px 28px;align-items:start;}
      .relationship-graph-widget .rg-group{min-width:0;padding:10px;border-radius:18px;background:color-mix(in srgb, ${widgetVar('canvas')} 62%, transparent);border:1px solid ${widgetVar('hair')};}
      .relationship-graph-widget .rg-pos-top,.relationship-graph-widget .rg-pos-bottom{grid-column:1 / -1;}
      .relationship-graph-widget .rg-pos-left{grid-column:1;}
      .relationship-graph-widget .rg-pos-center{grid-column:2;}
      .relationship-graph-widget .rg-pos-right{grid-column:3;}
      .relationship-graph-widget .rg-group-label{position:relative;z-index:4;display:flex;align-items:center;gap:7px;margin:0 0 9px;font-family:var(--widget-font-mono, ui-monospace, monospace);font-size:10px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${widgetVar('ink2')};}
      .relationship-graph-widget .rg-group-label span{width:8px;height:8px;border-radius:50%;background:var(--rg-group-color);}
      .relationship-graph-widget .rg-node-list{display:grid;gap:8px;}
      .relationship-graph-widget .rg-pos-top .rg-node-list,.relationship-graph-widget .rg-pos-bottom .rg-node-list{grid-template-columns:repeat(auto-fit,minmax(132px,1fr));}
      .relationship-graph-widget .rg-node{position:relative;z-index:4;border-radius:12px;background:${widgetVar('card')};border:1px solid ${widgetVar('hair')};padding:10px 11px;}
      .relationship-graph-widget .rg-node:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:4px;background:var(--rg-node-color);}
      .relationship-graph-widget .rg-node-primary{border-color:color-mix(in srgb, var(--rg-node-color) 45%, ${widgetVar('card')});box-shadow:0 1px 3px rgba(0,0,0,.06);}
      .relationship-graph-widget .rg-node-muted{opacity:.78;}
      .relationship-graph-widget .rg-node-title{font-size:13px;font-weight:600;color:${widgetVar('ink')};line-height:1.35;padding-left:5px;}
      .relationship-graph-widget .rg-node-subtitle{font-size:11px;color:${widgetVar('ink2')};line-height:1.35;margin-top:3px;padding-left:5px;}
      .relationship-graph-widget .rg-node-tag{display:inline-flex;margin:7px 0 0 5px;border-radius:999px;padding:3px 7px;border:1px solid ${widgetVar('hair')};color:${widgetVar('ink2')};font-family:var(--widget-font-mono, ui-monospace, monospace);font-size:10px;font-weight:500;letter-spacing:0.04em;}
      .relationship-graph-widget .rg-legend{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-family:var(--widget-font-mono, ui-monospace, monospace);font-size:10px;letter-spacing:0.04em;color:${widgetVar('ink2')};}
      .relationship-graph-widget .rg-legend span{display:inline-flex;align-items:center;gap:5px;}
      .relationship-graph-widget .rg-legend i{display:block;width:16px;height:3px;border-radius:999px;}
      .relationship-graph-widget .rg-edge-halo{fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.82;}
      .relationship-graph-widget .rg-edge-line{fill:none;stroke-linecap:round;stroke-linejoin:round;}
      .relationship-graph-widget .rg-edge-dot{stroke-width:3;}
      .relationship-graph-widget .rg-edge-label-bg{stroke-width:1;}
      .relationship-graph-widget .rg-edge-label{font-size:10px;font-weight:600;font-family:var(--widget-font-mono, ui-monospace, monospace);paint-order:stroke;stroke-width:3;stroke-linejoin:round;}
      .relationship-graph-widget .rg-note,.relationship-graph-widget .rg-warning{font-size:12px;color:${widgetVar('ink2')};margin-top:10px;}
      .relationship-graph-widget .rg-warning{color:${widgetVar('ink')};}
      @media (max-width:720px){.relationship-graph-widget .rg-groups{grid-template-columns:1fr;}.relationship-graph-widget .rg-group{grid-column:1 / -1 !important;}.relationship-graph-widget .rg-lines{display:none;}}
    </style>
    <div class="rg-head">
      <div>${renderHeader(props.heading || '关系图')}</div>
      ${legend}
    </div>
    <div class="rg-stage">
      <svg class="rg-lines" aria-hidden="true"></svg>
      <div class="rg-groups">${groupsHtml}</div>
    </div>
    ${warning}
    ${note}
    <script>(function(){
      const root=document.currentScript && document.currentScript.closest('[data-rg-root]');
      if(!root) return;
      const stage=root.querySelector('.rg-stage');
      const svg=root.querySelector('.rg-lines');
      const edges=${edgeData};
      const ns='http://www.w3.org/2000/svg';
      const styles=getComputedStyle(root);
      const haloColor=(styles.getPropertyValue('--widget-bg-primary')||'').trim()||'#FFFFFF';
      const labelBgColor=haloColor;
      const nodeMap=new Map();
      Array.from(root.querySelectorAll('[data-rg-node]')).forEach(function(node){
        nodeMap.set(node.getAttribute('data-rg-node'), node);
      });
      const groupMap=new Map();
      Array.from(root.querySelectorAll('[data-rg-group-panel]')).forEach(function(group){
        groupMap.set(group.getAttribute('data-rg-group-panel'), group);
      });
      function clear(node){ while(node.firstChild) node.removeChild(node.firstChild); }
      function box(element, origin){
        const rect=element.getBoundingClientRect();
        return {left:rect.left-origin.left,top:rect.top-origin.top,right:rect.right-origin.left,bottom:rect.bottom-origin.top,width:rect.width,height:rect.height,cx:rect.left-origin.left+rect.width/2,cy:rect.top-origin.top+rect.height/2};
      }
      function sidePoint(rect, side){
        if(side==='right') return {x:rect.right,y:rect.cy,side:'right'};
        if(side==='left') return {x:rect.left,y:rect.cy,side:'left'};
        if(side==='bottom') return {x:rect.cx,y:rect.bottom,side:'bottom'};
        return {x:rect.cx,y:rect.top,side:'top'};
      }
      function anchor(from,to){
        const dx=to.cx-from.cx;
        const dy=to.cy-from.cy;
        if(Math.abs(dx)>=Math.abs(dy)){
          return sidePoint(from, dx>=0 ? 'right' : 'left');
        }
        return sidePoint(from, dy>=0 ? 'bottom' : 'top');
      }
      function clamp(value, min, max){
        return Math.max(min, Math.min(max, value));
      }
      function directPathD(start, end){
        const bend=Math.max(30, Math.min(110, Math.abs(end.x-start.x)/2.4));
        const c1x=start.side==='right'?start.x+bend:start.side==='left'?start.x-bend:start.x;
        const c1y=start.side==='bottom'?start.y+bend:start.side==='top'?start.y-bend:start.y;
        const c2x=end.side==='right'?end.x+bend:end.side==='left'?end.x-bend:end.x;
        const c2y=end.side==='bottom'?end.y+bend:end.side==='top'?end.y-bend:end.y;
        return 'M '+start.x+' '+start.y+' C '+c1x+' '+c1y+', '+c2x+' '+c2y+', '+end.x+' '+end.y;
      }
      function groupForNode(node){
        const groupId=node.getAttribute('data-rg-group');
        return groupId ? groupMap.get(groupId) : null;
      }
      function railRoute(edge, fromNode, toNode, from, to, origin, width){
        const fromGroup=groupForNode(fromNode);
        const toGroup=groupForNode(toNode);
        if(!fromGroup || fromGroup!==toGroup) return null;
        const group=box(fromGroup,origin);
        const canRight=group.right+96<width;
        const canLeft=group.left-96>0;
        const index=Number(edge.routeIndex || 0);
        const side=canRight && (!canLeft || index%2===0) ? 'right' : canLeft ? 'left' : canRight ? 'right' : group.cx<width/2 ? 'right' : 'left';
        const gap=44+(index%3)*18;
        const railX=side==='right' ? clamp(group.right+gap, 10, width-10) : clamp(group.left-gap, 10, width-10);
        const start=sidePoint(from,side);
        const end=sidePoint(to,side);
        const d='M '+start.x+' '+start.y+' C '+railX+' '+start.y+', '+railX+' '+end.y+', '+end.x+' '+end.y;
        return {
          start:start,
          end:end,
          d:d,
          labelX:railX+(side==='right'?12:-12),
          labelY:(start.y+end.y)/2,
          labelAnchor:side==='right'?'start':'end',
        };
      }
      function routeFor(edge, fromNode, toNode, from, to, origin, width){
        const rail=railRoute(edge,fromNode,toNode,from,to,origin,width);
        if(rail) return rail;
        const start=anchor(from,to);
        const end=anchor(to,from);
        const dx=end.x-start.x;
        const dy=end.y-start.y;
        const tight=Math.abs(dx)<170 && Math.abs(dy)<86;
        if(tight){
          const lift=dy>=0 ? -24 : 24;
          const midX=(start.x+end.x)/2;
          const midY=(start.y+end.y)/2+lift;
          return {
            start:start,
            end:end,
            d:'M '+start.x+' '+start.y+' Q '+midX+' '+midY+', '+end.x+' '+end.y,
            labelX:midX,
            labelY:midY-3,
            labelAnchor:'middle',
          };
        }
        const labelOffset=((Number(edge.routeIndex || 0)%3)-1)*14;
        return {
          start:start,
          end:end,
          d:directPathD(start,end),
          labelX:(start.x+end.x)/2+labelOffset,
          labelY:(start.y+end.y)/2-8,
          labelAnchor:'middle',
        };
      }
      function makePath(edge, route, halo){
        const path=document.createElementNS(ns,'path');
        path.setAttribute('d',route.d);
        path.setAttribute('class',halo?'rg-edge-halo':'rg-edge-line');
        path.setAttribute('stroke',halo?haloColor:edge.color || '#666666');
        path.setAttribute('stroke-width',halo?(edge.weight==='heavy'?'8':edge.weight==='light'?'5':'6'):(edge.weight==='heavy'?'3.8':edge.weight==='light'?'1.8':'2.6'));
        path.setAttribute('opacity',halo?'.72':edge.weight==='light'?'.7':'.94');
        if(!halo && edge.style==='dashed') path.setAttribute('stroke-dasharray','8 7');
        if(!halo && edge.style==='dotted') path.setAttribute('stroke-dasharray','2 7');
        return path;
      }
      function makeDot(edge, point, radius){
        const circle=document.createElementNS(ns,'circle');
        circle.setAttribute('class','rg-edge-dot');
        circle.setAttribute('cx',String(point.x));
        circle.setAttribute('cy',String(point.y));
        circle.setAttribute('r',String(radius));
        circle.setAttribute('fill',edge.color || '#666666');
        circle.setAttribute('stroke',haloColor);
        return circle;
      }
      function appendLabel(edge, x, y, anchorMode){
        const label=String(edge.label || '').slice(0,18);
        if(!label) return;
        const group=document.createElementNS(ns,'g');
        const text=document.createElementNS(ns,'text');
        text.textContent=label;
        text.setAttribute('class','rg-edge-label');
        text.setAttribute('x',String(x));
        text.setAttribute('y',String(y));
        text.setAttribute('text-anchor',anchorMode || 'middle');
        text.setAttribute('fill',edge.color || '#666666');
        text.setAttribute('stroke',labelBgColor);
        group.appendChild(text);
        svg.appendChild(group);
        try{
          const bbox=text.getBBox();
          const rect=document.createElementNS(ns,'rect');
          rect.setAttribute('class','rg-edge-label-bg');
          rect.setAttribute('x',String(bbox.x-5));
          rect.setAttribute('y',String(bbox.y-3));
          rect.setAttribute('width',String(bbox.width+10));
          rect.setAttribute('height',String(bbox.height+6));
          rect.setAttribute('rx','8');
          rect.setAttribute('fill',labelBgColor);
          rect.setAttribute('fill-opacity','0.9');
          rect.setAttribute('stroke',(styles.getPropertyValue('--widget-border')||'').trim()||'#E8E5DE');
          group.insertBefore(rect,text);
        }catch(error){}
      }
      function render(){
        if(!stage || !svg) return;
        const origin=stage.getBoundingClientRect();
        const width=Math.max(stage.clientWidth,1);
        const height=Math.max(stage.clientHeight,1);
        svg.setAttribute('viewBox','0 0 '+width+' '+height);
        svg.setAttribute('width',String(width));
        svg.setAttribute('height',String(height));
        clear(svg);
        edges.forEach(function(edge){
          const fromNode=nodeMap.get(edge.from);
          const toNode=nodeMap.get(edge.to);
          if(!fromNode || !toNode) return;
          const from=box(fromNode,origin);
          const to=box(toNode,origin);
          const route=routeFor(edge,fromNode,toNode,from,to,origin,width);
          svg.appendChild(makePath(edge,route,true));
          svg.appendChild(makePath(edge,route,false));
          svg.appendChild(makeDot(edge,route.start,edge.weight==='heavy'?4.8:3.8));
          svg.appendChild(makeDot(edge,route.end,edge.weight==='heavy'?4.8:3.8));
          appendLabel(edge,route.labelX,route.labelY,route.labelAnchor);
        });
      }
      let raf=0;
      function schedule(){ if(raf) cancelAnimationFrame(raf); raf=requestAnimationFrame(render); }
      if(typeof ResizeObserver==='function'){
        const observer=new ResizeObserver(schedule);
        observer.observe(stage);
        nodeMap.forEach(function(node){ observer.observe(node); });
      }
      window.addEventListener('resize',schedule);
      schedule();
      setTimeout(schedule,80);
    })();</script>
  </div>`
}
