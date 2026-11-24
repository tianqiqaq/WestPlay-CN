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
  junctionAhead,
  junctionViewOf,
  showJunction,
} from '../maps/junctionView'
import { useMapData } from '../maps/mapData'

/**
 * The junction view: the next turn, zoomed in on a small 3D map (junctionView.ts), with the route through the
 * junction and arrows along it. The Dashboard's top widget; nothing at all without a turn close ahead (in
 * `JUNCTION_MAX_M`), so it takes no room but for those few hundred metres before each turn.
 *
 * Its map is a second MapLibre map of its own (the live map follows the truck, and one map can't be in two
 * places): made the first time the view shows, hidden while there's nothing to show, and taken down with the
 * Dashboard (its WebGL context and tiles go with it). The map is the junction's; the route's line is handed
 * to it with every turn, and the camera jumps there rather than easing (a press, not a drive).
 */

/** What the card shows, as values that stay put while nothing it draws changes: whether at all, and how far
 * (whole 10 m, so telemetry's 20 a second don't redraw the card). */
function selectJunction(state: LiveState) {
  const { route, routeNext, telemetry } = state
  const guidance = route
    ? guidanceOf(route.distances, route.maneuvers, routeNext, telemetry?.navigationDistance ?? 0)
    : null
  if (!guidance || !junctionAhead(guidance)) return { show: false, distance: 0, step: '' }
  const step = guidance.step.kind === 'turn' ? `${guidance.step.maneuver.node}:${guidance.step.maneuver.turn}` : ''
  return { show: true, distance: Math.round(guidance.distance / 10) * 10, step }
}

/** The junction ahead on the Dashboard (`null` before a route, or when the next turn is far or already here). */
export function JunctionView() {
  const text = useText()
  const { show, distance, step } = useLive(useShallow(selectJunction))
  const route = useLive((state) => state.route)
  const mph = useLive((state) => state.mph)
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
  // card coming and going. The distance is the one it opens with: the card's own badge below follows it, and
  // the route's line doesn't change on the way in.
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
        {visible && <span className="junction-distance">{formatTripDistance(distance, text.decimal, mph)}</span>}
      </div>
    </div>
  )
}

