import assert from 'node:assert/strict'
import test from 'node:test'

import {
  drawGraphCanvas,
  graphLabelOpacity,
  graphNodeRadius,
  findGraphNodeAtPoint,
  fitGraphViewport,
  shouldDrawGraphLabel,
} from '../renderer/components/graph/graph-canvas-renderer'

// The renderer takes the --rn-* token values read where the canvas sits (readGraphPalette); these stand in for the
// light and dark resolutions: the four ink levels and the signal colour.
const LIGHT_GRAPH_PALETTE = {
  document: 'rgba(11, 11, 14, .46)', tag: 'rgba(11, 11, 14, .64)', label: '#0b0b0e',
  edge: 'rgba(11, 11, 14, .22)', tagEdge: 'rgba(11, 11, 14, .22)', linkEdge: 'rgba(11, 11, 14, .46)', highlight: '#ff5a1f',
}
const DARK_GRAPH_PALETTE = {
  document: 'rgba(244, 244, 246, .46)', tag: 'rgba(244, 244, 246, .68)', label: '#f4f4f6',
  edge: 'rgba(244, 244, 246, .22)', tagEdge: 'rgba(244, 244, 246, .22)', linkEdge: 'rgba(244, 244, 246, .46)', highlight: '#ff5a1f',
}
import type { GraphNode } from '../renderer/components/graph/graph-types'

const nodes: GraphNode[] = [
  { id: 'doc:1', type: 'doc', label: 'one.md', sourceType: 'document', path: '/workspace/one.md' },
  { id: 'tag:notes', type: 'tag', label: 'notes' },
]

test('fitGraphViewport centers a circular graph and hit testing resolves the visible document', () => {
  const positions = new Float32Array([-100, 0, 100, 0])
  const viewport = fitGraphViewport(positions, 800, 600, 60)
  const docScreen = {
    x: -100 * viewport.zoom + viewport.x,
    y: viewport.y,
  }
  const hit = findGraphNodeAtPoint(nodes, positions, viewport, docScreen.x + 2, docScreen.y - 1)

  assert.equal(hit?.id, 'doc:1')
  assert.ok(viewport.zoom > 0)
  assert.ok(Math.abs(((-100 * viewport.zoom + viewport.x) + (100 * viewport.zoom + viewport.x)) / 2 - 400) < 1)
})

test('label level-of-detail hides the text cloud at overview zoom but keeps hovered context', () => {
  assert.equal(shouldDrawGraphLabel({ zoom: 0.35, nodeCount: 1700, isHovered: false, isRelated: false }), false)
  assert.equal(shouldDrawGraphLabel({ zoom: 0.35, nodeCount: 1700, isHovered: true, isRelated: true }), true)
  assert.equal(shouldDrawGraphLabel({ zoom: 1.2, nodeCount: 1700, isHovered: false, isRelated: true }), true)
})

test('label opacity rises continuously with zoom and connection importance', () => {
  const isolatedOverview = graphLabelOpacity({
    zoom: 0.9, nodeCount: 1700, degree: 0, isHovered: false, isRelated: false,
  })
  const connectedNear = graphLabelOpacity({
    zoom: 1.05, nodeCount: 1700, degree: 24, isHovered: false, isRelated: false,
  })
  const connectedCloser = graphLabelOpacity({
    zoom: 1.2, nodeCount: 1700, degree: 24, isHovered: false, isRelated: false,
  })
  const hoveredOverview = graphLabelOpacity({
    zoom: 0.1, nodeCount: 1700, degree: 0, isHovered: true, isRelated: false,
  })

  assert.equal(isolatedOverview, 0)
  assert.ok(connectedNear > 0 && connectedNear < 1)
  assert.ok(connectedCloser > connectedNear && connectedCloser <= 1)
  assert.equal(hoveredOverview, 1)
})

test('large overview uses small adaptive dots while connected and hovered nodes remain legible', () => {
  const isolatedOverview = graphNodeRadius({
    nodeType: 'doc',
    degree: 0,
    zoom: 0.1,
    nodeCount: 1700,
    isHovered: false,
  })
  const connectedOverview = graphNodeRadius({
    nodeType: 'doc',
    degree: 24,
    zoom: 0.1,
    nodeCount: 1700,
    isHovered: false,
  })
  const connectedCloseUp = graphNodeRadius({
    nodeType: 'doc',
    degree: 24,
    zoom: 1.2,
    nodeCount: 1700,
    isHovered: false,
  })
  const hoveredOverview = graphNodeRadius({
    nodeType: 'doc',
    degree: 0,
    zoom: 0.1,
    nodeCount: 1700,
    isHovered: true,
  })

  assert.ok(isolatedOverview >= 1.1 && isolatedOverview < 1.8)
  assert.ok(connectedOverview > isolatedOverview)
  assert.ok(connectedOverview < 5)
  assert.ok(connectedCloseUp > connectedOverview)
  assert.ok(hoveredOverview >= 5)
})

test('overlapping overview hit areas choose the geometrically nearest node', () => {
  const crowdedNodes: GraphNode[] = [
    { id: 'near', type: 'doc', label: 'near.md' },
    { id: 'far-but-later', type: 'doc', label: 'far.md' },
  ]
  const hit = findGraphNodeAtPoint(
    crowdedNodes,
    new Float32Array([0, 0, 6, 0]),
    { x: 100, y: 100, zoom: 1 },
    100.2,
    100,
  )

  assert.equal(hit?.id, 'near')
})

test('canvas drawing uses the adaptive overview radius', () => {
  const radii: number[] = []
  const canvas = { width: 0, height: 0 }
  const context = {
    canvas,
    setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillText() {},
    arc(_x: number, _y: number, radius: number) { radii.push(radius) },
  } as unknown as CanvasRenderingContext2D
  const graph = {
    nodes: [{ id: 'doc:1', type: 'doc' as const, label: 'one.md' }],
    edges: [],
    totalDocs: 1,
    truncated: false,
  }
  const baseOptions = {
    width: 400,
    height: 300,
    pixelRatio: 1,
    hoveredNodeId: null,
    relatedNodeIds: null,
    palette: DARK_GRAPH_PALETTE,
  }

  drawGraphCanvas(context, graph, new Float32Array([0, 0]), {
    ...baseOptions,
    viewport: { x: 200, y: 150, zoom: 0.1 },
  })
  const overviewRadius = radii.at(-1)!
  drawGraphCanvas(context, graph, new Float32Array([0, 0]), {
    ...baseOptions,
    viewport: { x: 200, y: 150, zoom: 1.2 },
  })

  assert.ok(radii.at(-1)! > overviewRadius)
})

test('connection roles distinguish hubs, satellites and isolated nodes in both themes and node types', () => {
  for (const palette of [LIGHT_GRAPH_PALETTE, DARK_GRAPH_PALETTE]) {
    for (const nodeType of ['doc', 'tag'] as const) {
      const marks: Array<{ color: string; radius: number }> = []
      let radius = 0
      const context = {
        canvas: { width: 0, height: 0 }, fillStyle: '',
        setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke() {}, fillText() {},
        arc(_x: number, _y: number, r: number) { radius = r },
        fill() { marks.push({ color: this.fillStyle, radius }) },
      } as unknown as CanvasRenderingContext2D
      const graph = {
        nodes: ['hub', 'leaf-a', 'leaf-b', 'leaf-c', 'leaf-d', 'isolated'].map((id) => ({ id, type: nodeType, label: id })),
        edges: ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-d'].map((target) => ({ source: 'hub', target, kind: 'wikilink' })),
        totalDocs: 6, truncated: false,
      }
      // Duplicate/reversed links, self links and missing targets are not extra neighbors.
      graph.edges.push(
        { source: 'leaf-a', target: 'hub', kind: 'tag-of' },
        { source: 'isolated', target: 'isolated', kind: 'wikilink' },
        { source: 'isolated', target: 'missing', kind: 'wikilink' },
      )
      drawGraphCanvas(context, graph, Float32Array.from([0, 0, 100, 0, 0, 100, -100, 0, 0, -100, 200, 200]), {
        width: 600, height: 400, pixelRatio: 1, viewport: { x: 200, y: 150, zoom: 0.35 },
        hoveredNodeId: null, relatedNodeIds: null, palette,
      })
      assert.equal(marks[0].color, palette.label, 'hub uses strong neutral ink')
      for (const mark of marks.slice(1, 5)) assert.equal(mark.color, palette.tag, 'satellites use the secondary ink regardless of file/tag type')
      assert.equal(marks[5].color, palette.document, 'unlinked points remain neutral')
      assert.ok(marks[0].radius >= marks[1].radius * 1.6, 'hub is visibly larger than its satellites')
    }
  }
})

test('canvas keeps the hovered label when nearby labels overlap', () => {
  const labels: string[] = []
  const context = {
    canvas: { width: 0, height: 0 },
    setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, arc() {},
    fillText(label: string) { labels.push(label) },
  } as unknown as CanvasRenderingContext2D
  const crowded = {
    nodes: [
      { id: 'low:1', type: 'doc' as const, label: 'low priority one' },
      { id: 'low:2', type: 'doc' as const, label: 'low priority two' },
      { id: 'hovered', type: 'doc' as const, label: 'hovered label' },
    ],
    edges: [], totalDocs: 3, truncated: false,
  }

  drawGraphCanvas(context, crowded, new Float32Array([0, 0, 2, 0, 4, 0]), {
    width: 400,
    height: 300,
    pixelRatio: 1,
    viewport: { x: 180, y: 150, zoom: 2.4 },
    hoveredNodeId: 'hovered',
    relatedNodeIds: null,
    palette: DARK_GRAPH_PALETTE,
  })

  assert.deepEqual(labels, ['hovered label'])
})
