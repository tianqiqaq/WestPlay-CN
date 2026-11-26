import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import 'maplibre-gl/dist/maplibre-gl.css'
import { formatTripDistance } from '../../shared/format'
import { useLook } from '../state/hooks'
import { useLive } from '../state/store'
import { useText } from '../state/text'
import { guidanceOf } from '../maps/guidance'
import { attachJunctionMap, junctionViewOf, showJunction, showTruck } from '../maps/junctionView'
import { useMapData } from '../maps/mapData'
import { junctionCardOf } from './junctionCard'

/**
 * The junction view: the next turn, zoomed in on a small 3D map (junctionView.ts), with the route through the
 * junction and arrows along it. It fills the top half of the map's split (MapSplit.tsx), which is closed while
 * there's no turn close ahead — so it takes no room but for the few hundred metres (the road's own:
 * `JUNCTION_MAX_M`) before each turn and the eighty after it.
 *
 * Its map is a second MapLibre map of its own (the live map follows the truck, and one map can't be in two
 * places): made the first time the view shows, hidden while there's nothing to show, and taken down when it
 * leaves the screen (its WebGL context and tiles go with it). The map is the junction's; the route's line is
 * handed to it with every turn, and the camera jumps there rather than easing (a press, not a drive).
 */

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

/** The junction ahead, in the map's split (`null` outside its panel: no route, or the turn far or past). */
export function JunctionView() {
  const { show, step, maneuver, following } = useLive(useShallow(junctionCardOf))
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
    return attachJunctionMap(element, { appearance, data })
  }, [shown, data, appearance])

  // The junction to show: a new turn, a new route, a new map (the map is made again with its data), or the
  // panel coming and going. The distance is the one it opens with: the badge follows the GPS's figure, and the
  // route's line doesn't change on the way in.
  useEffect(() => {
    if (!show || !maneuver || !route || !data) {
      showJunction(null)
      return
    }
    showJunction(junctionViewOf(route, { step: { kind: 'turn', maneuver }, distance: 0, then: null }))
  }, [show, maneuver, route, step, appearance, data])

  // The truck's own marker on the panel: the live map's puck, moved as the telemetry comes (no re-render).
  useEffect(() => {
    const update = () => {
      const telemetry = useLive.getState().telemetry
      showTruck(telemetry ? { x: telemetry.x, z: telemetry.z, heading: telemetry.heading } : null)
    }
    update()
    return useLive.subscribe(update)
  }, [])

  // The last card closed: nothing of the junction is wanted any more.
  useEffect(() => () => showJunction(null), [])

  return (
    <div className="junction-slot" aria-hidden={!visible}>
      <div className="junction" role="group" aria-label="Junction">
        <div ref={host} className="junction-map" aria-hidden />
        {visible && following && <JunctionDistance />}
      </div>
    </div>
  )
}
