import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import 'maplibre-gl/dist/maplibre-gl.css'
import { formatTripDistance } from '../../shared/format'
import { useLook } from '../state/hooks'
import { type LiveState, useLive } from '../state/store'
import { useText } from '../state/text'
import { guidanceOf, type Guidance } from '../maps/guidance'
import {
  attachJunctionMap,
  detachJunctionMap,
  facingOfHeading,
  junctionAhead,
  junctionRealDistance,
  junctionViewOf,
  showJunction,
} from '../maps/junctionView'
import { useMapData } from '../maps/mapData'

/**
 * The junction view: the next turn, zoomed in on a small 3D map (junctionView.ts), with the route through the
 * junction and arrows along it. The Dashboard's top widget; nothing at all without a turn close ahead, so it
 * takes no room but for the few hundred metres (the road's own: `JUNCTION_MAX_M`) before each turn.
 *
 * Its map is a second MapLibre map of its own (the live map follows the truck, and one map can't be in two
 * places): made the first time the view shows, hidden while there's nothing to show, and taken down with the
 * Dashboard (its WebGL context and tiles go with it). The map is the junction's; the route's line is handed
 * to it with every turn, and the camera jumps there rather than easing (a press, not a drive).
 */

/** Nothing to show: no route, no truck's place yet, arriving, far off or already through the turn. */
const CLOSED = { show: false, real: 0, step: '' }

/**
 * What the card shows, as values that stay put while nothing it draws changes: whether at all, the real road
 * distance it opened at (whole 10 m, so telemetry's 20 a second don't redraw the card), and which turn. The
 * trigger is the road's own metres (`junctionRealDistance`), not the GPS's scaled distances: those put a town
 * turn a few seconds off at best (the GPS counts about 3 or 19 of its metres to the road's one).
 */
function selectJunction(state: LiveState) {
  const { route, routeNext, telemetry } = state
  if (!route || !telemetry) return CLOSED
  const guidance = guidanceOf(route.distances, route.maneuvers, routeNext, telemetry.navigationDistance)
  if (!guidance || guidance.step.kind !== 'turn') return CLOSED
  const real = junctionRealDistance(
    route,
    guidance,
    [telemetry.x, telemetry.z],
    facingOfHeading(telemetry.heading),
    routeNext,
  )
  if (real === null || !junctionAhead(real)) return CLOSED
  const step = `${guidance.step.maneuver.node}:${guidance.step.maneuver.turn}`
  return { show: true, real: Math.round(real / 10) * 10, step }
}

/** How far the GPS says the turn is, worded as the turn-by-turn card words it (its game distances, so the cab
 * and the GPS agree). The words change only when the figure does, so telemetry's 20 a second redraw nothing. */
function JunctionDistance() {
  const text = useText()
  const words = useLive((state) => {
    const route = state.route
    const guidance = route
      ? guidanceOf(route.distances, route.maneuvers, state.routeNext, state.telemetry?.navigationDistance ?? 0)
      : null
    return guidance ? formatTripDistance(guidance.distance, text.decimal, state.mph) : ''
  })
  return words ? <span className="junction-distance">{words}</span> : null
}

/** The junction ahead on the Dashboard (`null` before a route, or when the next turn is far or already here). */
export function JunctionView() {
  const { show, step } = useLive(useShallow(selectJunction))
  const route = useLive((state) => state.route)
  const data = useMapData()
  const { appearance } = useLook()
  const host = useRef<HTMLDivElement>(null)
  // Whether the view has shown once: the map is made then, not with the Dashboard (which may never turn).
  const [shown, setShown] = useState(show)
  // Adjusted while rendering (React's way for state that follows a prop): the map is made in the same commit.
  if (show && !shown) setShown(true)
  // No map data, no junction view: the route may be known before the map's build is.
  const visible = show && data !== null && data !== undefined

  // The map, once there's a junction to show and a map to draw. Made with the appearance it opens in;
  // another appearance makes another map (a handful of times a drive: night falls, headlights go on).
  useEffect(() => {
    if (!shown || !data || !host.current) return
    const element = host.current
    attachJunctionMap(element, { appearance, data })
    return () => detachJunctionMap({ remove: true })
  }, [shown, data, appearance])

  // The junction to show: a new turn, a new route, a new map (the map is made again with its data), or the
  // card coming and going. The distance is the one it opens with: the card's own badge below follows the
  // GPS's figure, and the route's line doesn't change on the way in.
  useEffect(() => {
    if (!show || !data) {
      showJunction(null)
      return
    }
    const live = useLive.getState()
    const guidance: Guidance | null = route
      ? guidanceOf(route.distances, route.maneuvers, live.routeNext, live.telemetry?.navigationDistance ?? 0)
      : null
    showJunction(route && guidance ? junctionViewOf(route, guidance) : null)
  }, [show, route, step, appearance, data])

  // The last card closed: nothing of the junction is wanted any more.
  useEffect(() => () => showJunction(null), [])

  return (
    <div className={`widget-slot junction-slot${visible ? ' open' : ''}`} aria-hidden={!visible}>
      <div className="widget junction" role="group" aria-label="Junction">
        <div ref={host} className="junction-map" aria-hidden />
        {visible && <JunctionDistance />}
      </div>
    </div>
  )
}
