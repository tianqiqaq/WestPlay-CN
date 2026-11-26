import type { Appearance } from '../state/appearance'
import type { Guidance, Maneuver } from './guidance'
import type { MapData } from './mapData'
import { bearingOf as bearingOfHeading } from './camera'
import { toLngLat } from './projection'
import { type Point, progressOf, type RouteNode, routeSpans, type Spans } from './route'
import { mapStyle } from './style'

/**
 * The junction view: the turn ahead, zoomed in (Dashboard.tsx's widget, JunctionView.tsx), as CarPlay's
 * junction cards and a truck's own navigation show it — a pressed-down look at the junction, with the route
 * through it and arrows along it.
 *
 * The card's trigger, the part of the route it shows and the way its camera faces are plain functions here
 * (tested without a browser, junctionView.test.ts); the mini map itself is a second MapLibre map of its own,
 * made lazily the first time there's something to show (never at the module's top: tests and the companion's
 * pages have no DOM). The live map (liveMap.ts) is left alone: its one map can't be in two places, and its
 * camera follows the truck.
 *
 * The trigger is the route's real length, `junctionRealDistance`: the game's GPS measures in its own scaled
 * distances (about 19 to 1 between towns, 3 to 1 in them), so `guidanceOf`'s distance is no use for "close"
 * (350 of its metres are about 18 real ones: a turn came and went unseen). Everything the card says stays the
 * game's, so it agrees with the GPS; only the showing is by the road's own metres.
 *
 * The style is the live map's own (`mapStyle`), so the junction is drawn from the same tiles, roads and
 * buildings, with the places and signs left off (they'd need drawing, and are clutter this close).
 */

export interface JunctionView {
  /** The junction, on the game's ground: x east, z south, metres. */
  center: [x: number, z: number]
  /** Where the camera looks along: the bearing of the way the truck enters the junction, degrees clockwise
   * from north (MapLibre's own). */
  bearing: number
  /** The route through the junction: from `JUNCTION_BEFORE_M` before it to `JUNCTION_AFTER_M` after. */
  line: Point[]
  /** How far the truck is from the junction as the game's GPS counts it (what the card's words say); whether
   * the view shows is `junctionRealDistance`'s, the road's own metres. */
  distance: number
}

/** How far along the route the view starts before the junction, and ends after it, metres. */
export const JUNCTION_BEFORE_M = 400
export const JUNCTION_AFTER_M = 200
/**
 * How far before the junction the view shows, in real road metres — not the game's GPS distances (about 19 to
 * 1 out of town, 3 to 1 in it: 350 of its metres are about 18 real ones, and the turn was past before the card
 * had been seen). 350 m is a ramp's ~5 km of the GPS's, and a town turn's ~1 km.
 */
export const JUNCTION_MAX_M = 350
/**
 * How far past the junction the view stays, real road metres: through the turn, not until the GPS moves on to
 * the next one (which happens a node or two after the junction, while the truck is still turning).
 */
export const JUNCTION_PAST_M = 80
/** How far back from the junction the camera's bearing is taken, metres. */
export const JUNCTION_APPROACH_M = 20
/** The mini map's camera: above and behind the junction, looking down the way in. */
export const JUNCTION_ZOOM = 17.8
export const JUNCTION_PITCH = 55
/** The dimming above the map's ground, and the route's colours over it. */
export const JUNCTION_DIM_OPACITY = 0.35
export const JUNCTION_ROUTE_COLOUR = '#ffcc00'
export const JUNCTION_CASING_COLOUR = '#06232b'
/** Between two arrows along the route, pixels. */
export const JUNCTION_CHEVRON_SPACING = 76

/**
 * Whether the junction view shows, from the turn's real road distance (`junctionRealDistance`, signed: positive
 * before the junction, negative past it): from `JUNCTION_MAX_M` before it to `JUNCTION_PAST_M` after it — the
 * truck in the junction and still turning included. `null` (no route, arriving, nothing to measure): no.
 */
export function junctionAhead(distance: number | null): boolean {
  return distance !== null && distance <= JUNCTION_MAX_M && distance >= -JUNCTION_PAST_M
}

/**
 * A compass bearing (degrees clockwise from north, as MapLibre's) for a direction on the game's ground
 * (x east, z south): north is `-z`, east `+x`.
 */
export function bearingOfDirection(dx: number, dz: number): number {
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI
  return ((degrees % 360) + 360) % 360
}

/** The bearing from `from` to `to`, on the game's ground. */
export function bearingOf(from: Point, to: Point): number {
  return bearingOfDirection(to[0] - from[0], to[1] - from[1])
}

/** The part of a route the junction view needs: its nodes, the ways through its junctions and how far across
 * to run (live's `route`, state/store.ts). */
export interface JunctionRoute {
  nodes: readonly RouteNode[]
  paths: ReadonlyMap<number, Point[]>
  shifts: ReadonlyMap<number, number>
}

/**
 * The junction view of a route's next step (`null`: no route, arriving, or no such node). Its showing is the
 * caller's, by `junctionRealDistance` (and `junctionAhead`): this is the picture, not the trigger.
 */
export function junctionViewOf(route: JunctionRoute, guidance: Guidance | null): JunctionView | null {
  if (!guidance || guidance.step.kind !== 'turn') return null
  const node = guidance.step.maneuver.node
  const centre = route.nodes[node]
  if (!centre) return null
  const center: [number, number] = [centre.position[0], centre.position[1]]
  const { spans, at } = junctionSpans(route, node)
  const slice = junctionSlice(spans, at)
  if (!slice || slice.line.length < 2) return null
  // Along the line as it runs, not from the node to it: on a road drawn as two carriageways the line is
  // shifted onto the one driven on, and the camera must look down that, not across.
  const entry = backFrom(slice.line, slice.centre, JUNCTION_APPROACH_M)
  const bearing = entry
    ? bearingOf(entry, slice.line[slice.centre])
    : bearingOfDirection(centre.forward[0], centre.forward[1])
  return { center, bearing, line: slice.line, distance: guidance.distance }
}

/**
 * The way the truck faces, on the game's ground (x east, z south), from its heading: turns, 0 = north and
 * rising counter-clockwise (0.25 west, 0.5 south, 0.75 east: the game's own, `Telemetry.heading`).
 */
export function facingOfHeading(heading: number): Point {
  const radians = 2 * Math.PI * heading
  return [-Math.sin(radians), -Math.cos(radians)]
}

/** How many nodes either side of the junction the spans are made from: more than the route's 400 m before and
 * 200 m after cover in any town, and far fewer than a route across the map has (tens of thousands of nodes:
 * the view mustn't build the whole route's spans for one turn). */
const JUNCTION_WINDOW = 80

/** The route's spans around the junction `node`, and where the junction is among them (its slice's node). */
function junctionSpans(route: JunctionRoute, node: number): { spans: Spans; at: number } {
  const first = Math.max(0, node - JUNCTION_WINDOW)
  const last = Math.min(route.nodes.length - 1, node + JUNCTION_WINDOW)
  const nodes = route.nodes.slice(first, last + 1)
  // The junction lanes and the across-shifts are keyed by the route's own nodes: their slice's own.
  const paths = new Map<number, Point[]>()
  for (const [key, value] of route.paths) if (key >= first && key < last) paths.set(key - first, value)
  const shifts = new Map<number, number>()
  for (const [key, value] of route.shifts) if (key >= first && key <= last) shifts.set(key - first, value)
  return { spans: routeSpans(nodes, paths, shifts), at: node - first }
}

/** How far past the junction the real-distance slice runs (real metres), so the truck is still on it at
 * `JUNCTION_PAST_M`, and the most nodes it runs past it (a bound on what one call builds). */
const JUNCTION_SLICE_AFTER_M = JUNCTION_PAST_M + 40
const JUNCTION_SLICE_AFTER_NODES = 48

/** The route around the junction, as `junctionRealDistance` needs it: the truck's own node back from the
 * junction with the way past it, its line, how far along it each point is, and where the junction is on it. */
interface RealSlice {
  route: JunctionRoute
  node: number
  next: number
  spans: Spans
  line: Point[]
  /** Arc length from the slice's first point to each of its points. */
  lengths: number[]
  /** Where each span starts among `line`'s points. */
  spanStart: number[]
  /** The junction's point among `line`'s points, and the arc length to it. */
  centre: number
  centreLength: number
  /** The slice's first node of the route. */
  first: number
}

/** The slice last built: the route around a junction stays the same while the truck drives it. */
let realSlice: RealSlice | null = null

/**
 * The route from the truck's node (or the junction's, if that's behind it) to `JUNCTION_SLICE_AFTER_M` past the
 * junction, kept from one call to the next: at telemetry's rate only the truck's own progress changes, and
 * rebuilding the spans 20 times a second for one turn would be wasted work.
 */
function realSliceFor(route: JunctionRoute, node: number, next: number): RealSlice | null {
  if (realSlice && realSlice.route === route && realSlice.node === node && realSlice.next === next) return realSlice
  const first = Math.max(0, Math.min(next - 1, node))
  // Past the junction, far enough that the truck is still on the slice at `JUNCTION_PAST_M`: the nodes' own
  // distances (a curve's road is longer, and the bound is only where the slice stops being needed).
  let last = node
  let run = 0
  while (last < route.nodes.length - 1 && last - node < JUNCTION_SLICE_AFTER_NODES && run < JUNCTION_SLICE_AFTER_M) {
    run += lengthOf(route.nodes[last].position, route.nodes[last + 1].position)
    last++
  }
  const nodes = route.nodes.slice(first, last + 1)
  if (nodes.length < 2) return null
  // The junction lanes and the across-shifts are keyed by the route's own nodes: their slice's own.
  const paths = new Map<number, Point[]>()
  for (const [key, value] of route.paths) if (key >= first && key < last) paths.set(key - first, value)
  const shifts = new Map<number, number>()
  for (const [key, value] of route.shifts) if (key >= first && key <= last) shifts.set(key - first, value)
  const spans = routeSpans(nodes, paths, shifts)
  const line = flatten(spans)
  if (line.length < 2) return null
  const lengths = [0]
  for (let at = 1; at < line.length; at++) lengths.push(lengths[at - 1] + lengthOf(line[at - 1], line[at]))
  const spanStart: number[] = []
  let points = 0
  for (const span of spans) {
    spanStart.push(points)
    points += Math.max(0, span.length - 1)
  }
  // The junction's own point: the start of its span, or the line's last point when it's the route's last node.
  const local = node - first
  const centre = Math.min(local < spanStart.length ? spanStart[local] : line.length - 1, line.length - 1)
  const slice: RealSlice = {
    route,
    node,
    next,
    spans,
    line,
    lengths,
    spanStart,
    centre,
    centreLength: lengths[centre],
    first,
  }
  realSlice = slice
  return slice
}

/**
 * How far the truck is from the next turn's junction along the road, in real metres — never the game's GPS
 * distances, which are about 19 to 1 between towns and 3 to 1 in them. Positive before the junction, negative
 * once it's behind the truck (so the view can stay through the turn: `junctionAhead`), `null` when nothing can
 * be measured (no turn, off the route, no spans).
 *
 * The truck is placed on the route from its own node to the way past the junction (`progressOf`, which knows
 * the way the truck faces: a road with both directions on it), and measured to the junction's own node. `next`
 * is the node ahead of the truck (live's `routeNext`) the slice and `progressOf` start from. A truck whose
 * straight line to the junction is already past `JUNCTION_MAX_M` can't be nearer by road (a road is never
 * shorter than the straight line), so no spans are built then and that lower bound is returned: `junctionAhead`
 * says no either way, and turns still kilometres off cost nothing.
 */
export function junctionRealDistance(
  route: JunctionRoute,
  guidance: Guidance | null,
  truck: [number, number],
  facing?: [number, number],
  next = 0,
): number | null {
  if (!guidance || guidance.step.kind !== 'turn') return null
  const node = guidance.step.maneuver.node
  const centreNode = route.nodes[node]
  if (!centreNode) return null
  const [cx, cz] = centreNode.position
  const straight = Math.hypot(cx - truck[0], cz - truck[1])
  if (straight > JUNCTION_MAX_M) return straight
  const slice = realSliceFor(route, node, next)
  if (!slice) return null
  const progress = progressOf(slice.spans, Math.max(0, next - slice.first), truck, facing)
  if (!progress) return null
  const at = Math.min(slice.spanStart[progress.span] + progress.index, slice.line.length - 1)
  const travelled = slice.lengths[at] + lengthOf(slice.line[at], progress.at)
  // Signed: past the junction, its arc length is behind the truck's.
  return slice.centreLength - travelled
}

/** The turn the junction view should show, and the signed real road distance to it (metres). */
export interface JunctionPick {
  maneuver: Maneuver
  /** Signed: negative once the junction is behind the truck (`junctionAhead` bounds both ways). */
  distance: number
  /** Whether it's the GPS's next step (`false`: the GPS has moved on, and the truck is still coming out of the
   * junction). */
  following: boolean
}

/**
 * Which turn the panel shows: the GPS's next one while its junction is in reach (`junctionAhead`), else the
 * last one behind the truck while the truck is still coming out of it (the GPS moves on to the next step a
 * node or two past the junction, before the turn is driven out). `null`: nothing.
 */
export function junctionPickOf(
  route: JunctionRoute,
  maneuvers: readonly Maneuver[],
  next: number,
  truck: [number, number],
  facing?: [number, number],
  guidance?: Guidance | null,
): JunctionPick | null {
  if (guidance?.step.kind === 'turn') {
    const distance = junctionRealDistance(route, guidance, truck, facing, next)
    if (distance !== null && junctionAhead(distance)) {
      return { maneuver: guidance.step.maneuver, distance, following: true }
    }
  }
  const passed = lastPassed(maneuvers, next)
  if (passed) {
    const distance = junctionRealDistance(route, asTurn(passed), truck, facing, next)
    if (distance !== null && distance <= 0 && junctionAhead(distance)) {
      return { maneuver: passed, distance, following: false }
    }
  }
  return null
}

/** A turn's guidance for the geometry alone (`junctionRealDistance` reads its step, not the GPS's distance). */
function asTurn(maneuver: Maneuver): Guidance {
  return { step: { kind: 'turn', maneuver }, distance: 0, then: null }
}

/**
 * The last turn the GPS has moved past (`node <= next - 2`: `guidanceOf` keeps one while
 * `node >= next - 1`), or `null`. Maneuvers come in route order.
 */
function lastPassed(maneuvers: readonly Maneuver[], next: number): Maneuver | null {
  for (let at = maneuvers.length - 1; at >= 0; at--) {
    if (maneuvers[at].node <= next - 2) return maneuvers[at]
  }
  return null
}

/** The route through the junction `node`: a slice of the spans, and where the junction is in that slice. */
interface Slice {
  line: Point[]
  centre: number
}

/**
 * The slices of the route's spans around the junction `node`: `JUNCTION_BEFORE_M` of the route before it and
 * `JUNCTION_AFTER_M` after, the ends cut where the distances fall between two points. `null` without spans.
 */
function junctionSlice(spans: Spans, node: number): Slice | null {
  const line = flatten(spans)
  if (line.length < 2) return null
  // Every node after the first is a span's first point, which the span before it already ends at: the
  // flattening keeps one of each.
  const centre = Math.min(
    spans.slice(0, node).reduce((count, span) => count + Math.max(0, span.length - 1), 0),
    line.length - 1,
  )
  // Back along the route, to `JUNCTION_BEFORE_M` before the junction (an end between two points is placed
  // there): kept nearest first, then turned round.
  const before: Point[] = []
  let index = centre
  let left = JUNCTION_BEFORE_M
  while (index > 0 && left > 0) {
    const step = lengthOf(line[index], line[index - 1])
    if (step >= left) {
      before.push(along(line[index], line[index - 1], left / step))
      left = 0
    } else {
      before.push(line[index - 1])
      left -= step
      index--
    }
  }
  before.reverse()
  // On, to `JUNCTION_AFTER_M` after it, the same way.
  const after: Point[] = []
  index = centre
  let right = JUNCTION_AFTER_M
  while (index < line.length - 1 && right > 0) {
    const step = lengthOf(line[index], line[index + 1])
    if (step >= right) {
      after.push(along(line[index], line[index + 1], right / step))
      right = 0
    } else {
      after.push(line[index + 1])
      right -= step
      index++
    }
  }
  return { line: [...before, line[centre], ...after], centre: before.length }
}

/** Every point of the spans, once, in order: a span's first point is the one before it's last. */
function flatten(spans: Spans): Point[] {
  const line: Point[] = []
  spans.forEach((span, index) => {
    for (let at = index === 0 ? 0 : 1; at < span.length; at++) {
      const point = span[at]
      const last = line.at(-1)
      if (last && last[0] === point[0] && last[1] === point[1]) continue
      line.push(point)
    }
  })
  return line
}

/** The point `metres` back from `from` along `line` (`null`: the line is shorter than that before it). */
function backFrom(line: readonly Point[], from: number, metres: number): Point | null {
  let index = from
  let left = metres
  while (index > 0 && left > 0) {
    const step = lengthOf(line[index], line[index - 1])
    if (step >= left) return along(line[index], line[index - 1], left / step)
    left -= step
    index--
  }
  return null
}

function lengthOf(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** The point `ratio` (0 to 1) of the way from `a` to `b`. */
function along(a: Point, b: Point, ratio: number): Point {
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]
}

/* --- The mini map ---------------------------------------------------------------------------------- */

type MapInstance = import('maplibre-gl').Map
type GeoSource = import('maplibre-gl').GeoJSONSource
type LineData = Parameters<GeoSource['setData']>[0]

const DIM_LAYER = 'junction-dim'
const ROUTE_SOURCE = 'junction-route'
const ROUTE_CASING_LAYER = 'junction-route-casing'
const ROUTE_LAYER = 'junction-route'
const CHEVRON_LAYER = 'junction-chevrons'
const CHEVRON_ICON = 'junction-chevron'
/** The arrow is drawn this many pixels square, as a pixel ratio of 2 (half that on screen). */
const CHEVRON_PIXELS = 64
/** The live map's style draws these, which the junction view does without: their images are drawn per frame
 * on demand (placeIcons.ts), and at a junction's zoom they read as clutter. */
const DROPPED_LAYERS = ['places-badges', 'places', 'road-signs', 'no-entry']

const NO_LINE: LineData = { type: 'FeatureCollection', features: [] }

/** What the mini map is made with. */
export interface JunctionMapOptions {
  appearance: Appearance
  data: MapData
  /** The junction to show as the map comes in (`showJunction` for the ones after). */
  view?: JunctionView | null
}

let map: MapInstance | null = null
/** Whether the style is loaded (its layers are there to draw in). */
let ready = false
/** The junction to show: the last `showJunction` asked for. */
let wanted: JunctionView | null = null
/** Which map is the current one: a late creation or load for an older one changes nothing. */
let generation = 0
let resizing: number | null = null
let observer: ResizeObserver | null = null
/** The truck's position as the panel has it (the live map's puck, showTruck): 
ull while it's not known. */
let wantedTruck: { x: number; z: number; heading: number } | null = null
/** The live map's truck marker (map-puck), over this map's canvas. */
let puck: import('maplibre-gl').Marker | null = null

/**
 * Makes the junction view's map in `element` (lazily: the first call), and shows `options.view` in it.
 * Nothing is created before this. Returns the function that takes it down (its WebGL context and tiles with
 * it); a map a newer `attachJunctionMap` has since taken (two screens' panels for a moment, a screen changing)
 * is left to that newer one.
 */
export function attachJunctionMap(element: HTMLElement, options: JunctionMapOptions): () => void {
  const mine = ++generation
  wanted = options.view ?? wanted
  ready = false
  // One map at a time: a second attach (the component mounted afresh) takes the first down.
  const previous = map
  map = null
  observer?.disconnect()
  observer = null
  if (resizing !== null) cancelAnimationFrame(resizing)
  resizing = null
  if (previous) previous.remove()
  void create(mine, element, options)
  return () => {
    if (mine === generation) detachJunctionMap({ remove: true })
  }
}

/**
 * Takes the junction view's map down. `remove` (the default): its WebGL context and tiles go too, for a
 * screen left for good; without it, the map is kept (hidden) for the next junction.
 */
export function detachJunctionMap({ remove = true }: { remove?: boolean } = {}): void {
  generation++
  wanted = null
  ready = false
  if (resizing !== null) cancelAnimationFrame(resizing)
  resizing = null
  observer?.disconnect()
  observer = null
  const instance = map
  map = null
  if (puck) puck.getElement().style.visibility = 'hidden'
  puck = null
  wantedTruck = null
  if (!instance) return
  if (remove) instance.remove()
  else instance.getCanvas().style.visibility = 'hidden'
}

/** Shows `view` in the junction view's map, or hides it (`null`). */
export function showJunction(view: JunctionView | null): void {
  wanted = view
  const instance = map
  if (!instance) return
  if (!ready) {
    if (!view) instance.getCanvas().style.visibility = 'hidden'
    return
  }
  applyWanted(instance)
  applyTruck()
}

/** Where the truck is, for the panel's own marker (`null`: not known, and none shows). */
export function showTruck(truck: { x: number; z: number; heading: number } | null): void {
  wantedTruck = truck
  applyTruck()
}

/** Puts the truck's marker where it is, turned the way it faces (the live map's `bearingOf`), when the panel shows. */
function applyTruck(): void {
  if (!puck) return
  const element = puck.getElement()
  if (!wanted || !wantedTruck) {
    element.style.visibility = 'hidden'
    return
  }
  element.style.visibility = 'visible'
  puck.setLngLat(toLngLat(wantedTruck.x, wantedTruck.z)).setRotation(bearingOfHeading(wantedTruck.heading))
}
async function create(mine: number, element: HTMLElement, options: JunctionMapOptions) {
  // MapLibre is loaded here, never at the module's top: the tests (and the pages that never show a junction)
  // have no DOM. Its worker URL is the live map's (liveMap.ts): one page, one worker file.
  const { default: maplibregl } = await import('maplibre-gl')
  if (mine !== generation) return
  const instance = new maplibregl.Map({
    container: element,
    style: mapStyle(options.appearance, options.data),
    center: options.data.centre,
    zoom: JUNCTION_ZOOM,
    pitch: JUNCTION_PITCH,
    maxPitch: 70,
    minZoom: 12,
    maxZoom: 19.5,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    canvasContextAttributes: { antialias: true },
  })
  map = instance
  ready = false
  instance.getCanvas().style.visibility = 'hidden'
  // The truck's own marker, the live map's (map-puck): a marker over the canvas, so it needs no style.
  const puckElement = document.createElement('div')
  puckElement.className = 'map-puck map-puck-junction'
  puckElement.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 18 19l-6-3.2L6 19Z" fill="currentColor"/></svg>'
  puckElement.style.visibility = 'hidden'
  puck = new maplibregl.Marker({ element: puckElement, pitchAlignment: 'viewport', rotationAlignment: 'map' })
  puck.setLngLat(toLngLat(wantedTruck?.x ?? 0, wantedTruck?.z ?? 0)).addTo(instance)
  // `style.load`, not `load`: the layers can be added as soon as the style is parsed, without waiting for the
  // first tiles.
  instance.on('style.load', () => {
    if (mine !== generation || map !== instance) return
    for (const id of DROPPED_LAYERS) if (instance.getLayer(id)) instance.removeLayer(id)
    addLayers(instance)
    ready = true
    applyWanted(instance)
    applyTruck()
  })
  observer = new ResizeObserver(() => scheduleResize(instance))
  observer.observe(element)
  if (element.clientWidth > 0 && element.clientHeight > 0) instance.resize()
}

/** The dimming, the route through the junction and its arrows: over everything the style draws. */
function addLayers(instance: MapInstance): void {
  if (instance.getLayer(DIM_LAYER)) return
  if (!instance.hasImage(CHEVRON_ICON)) instance.addImage(CHEVRON_ICON, chevronImage(), { pixelRatio: 2 })
  // Dim the whole map first: the route drawn after it is the only thing at full brightness.
  instance.addLayer({
    id: DIM_LAYER,
    type: 'background',
    paint: { 'background-color': '#000000', 'background-opacity': JUNCTION_DIM_OPACITY },
  })
  if (!instance.getSource(ROUTE_SOURCE)) instance.addSource(ROUTE_SOURCE, { type: 'geojson', data: NO_LINE })
  instance.addLayer({
    id: ROUTE_CASING_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': JUNCTION_CASING_COLOUR, 'line-width': 22, 'line-opacity': 0.95 },
  })
  instance.addLayer({
    id: ROUTE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': JUNCTION_ROUTE_COLOUR, 'line-width': 15 },
  })
  instance.addLayer({
    id: CHEVRON_LAYER,
    type: 'symbol',
    source: ROUTE_SOURCE,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': JUNCTION_CHEVRON_SPACING,
      'icon-image': CHEVRON_ICON,
      // The arrow turns with the road it's on, pointing the way the route runs.
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-avoid-edges': false,
      // The image's arrow points up; the route's line turns it, and this turns the tip the rest of the way round.
      'icon-rotate': 90,
      // The panel is half the map's height: the arrow a little larger than it was in a widget.
      'icon-size': 1.35,
    },
  })
}

/** A white chevron, pointing up (north in the image: MapLibre turns it along the line), on nothing. */
function chevronImage(): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = CHEVRON_PIXELS
  canvas.height = CHEVRON_PIXELS
  const context = canvas.getContext('2d')
  if (!context) throw new Error('junction view: no 2d context for the arrow')
  context.lineCap = 'butt'
  context.lineJoin = 'miter'
  context.miterLimit = 10
  context.beginPath()
  context.moveTo(CHEVRON_PIXELS * 0.22, CHEVRON_PIXELS * 0.78)
  context.lineTo(CHEVRON_PIXELS * 0.5, CHEVRON_PIXELS * 0.2)
  context.lineTo(CHEVRON_PIXELS * 0.78, CHEVRON_PIXELS * 0.78)
  // A dark casing first, the yellow arrow over it: thick, and clear on the bright route line.
  context.strokeStyle = '#06232b'
  context.lineWidth = 26
  context.stroke()
  context.strokeStyle = '#ffcc00'
  context.lineWidth = 18
  context.stroke()
  return context.getImageData(0, 0, CHEVRON_PIXELS, CHEVRON_PIXELS)
}

/** Brings the map to the junction last asked for (or hides it). */
function applyWanted(instance: MapInstance): void {
  const view = wanted
  const canvas = instance.getCanvas()
  if (!view) {
    canvas.style.visibility = 'hidden'
    if (puck) puck.getElement().style.visibility = 'hidden'
    return
  }
  if (instance.getContainer().clientWidth > 0 && instance.getContainer().clientHeight > 0) instance.resize()
  instance.jumpTo({
    center: toLngLat(view.center[0], view.center[1]),
    bearing: view.bearing,
    zoom: JUNCTION_ZOOM,
    pitch: JUNCTION_PITCH,
  })
  instance.getSource<GeoSource>(ROUTE_SOURCE)?.setData(lineData(view.line))
  canvas.style.visibility = 'visible'
}

/** The route through the junction, as the map's source has it. */
function lineData(line: readonly Point[]): LineData {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: line.map(([x, z]) => toLngLat(x, z)) },
  }
}

/**
 * Resizes the map once a frame at most (the widget grows as it opens: every frame of that would be a resize,
 * and each one lays the map out again). A map whose widget is put away (no room at all) is left as it is.
 */
function scheduleResize(instance: MapInstance): void {
  if (resizing !== null) return
  resizing = requestAnimationFrame(() => {
    resizing = null
    if (map !== instance) return
    const container = instance.getContainer()
    if (container.clientWidth === 0 || container.clientHeight === 0) return
    instance.resize()
  })
}
