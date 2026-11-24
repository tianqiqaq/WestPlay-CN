import type { Maneuver } from '../maps/guidance'
import { guidanceOf } from '../maps/guidance'
import { facingOfHeading, junctionPickOf } from '../maps/junctionView'
import { useMapData } from '../maps/mapData'
import { type LiveState, useLive } from '../state/store'

/**
 * What the junction view shows, from the live state: the next turn, the real road distance to its junction and
 * whether it's the GPS's own next step. In a file of its own (a hook or a plain function exported beside a
 * component costs Fast Refresh a full reload).
 *
 * The choosing is `junctionPickOf`'s (junctionView.ts), on the road's own metres — the GPS's scaled distances
 * put a town turn a few seconds off, and the panel must stay through the turn itself — with the geometry it
 * needs cached there.
 */
export interface JunctionCard {
  show: boolean
  /** The real road distance to the junction, whole 10 m (signed: negative past it). Not what the badge says:
   * that's the GPS's. */
  real: number
  /** Which turn, and whether it's the GPS's next step (`false`: passed, the GPS moved on — the panel shows it
   * coming out of the junction, without the badge). */
  step: string
  maneuver: Maneuver | null
  following: boolean
}

/** Nothing to show: no route, no truck's place yet, arriving, too far off or past the turn. */
const CLOSED: JunctionCard = { show: false, real: 0, step: '', maneuver: null, following: false }

/** The junction view's state for the live state. */
export function junctionCardOf(state: LiveState): JunctionCard {
  const { route, routeNext, telemetry } = state
  if (!route || !telemetry) return CLOSED
  const guidance = guidanceOf(route.distances, route.maneuvers, routeNext, telemetry.navigationDistance)
  const pick = junctionPickOf(
    route,
    route.maneuvers,
    routeNext,
    [telemetry.x, telemetry.z],
    facingOfHeading(telemetry.heading),
    guidance,
  )
  if (!pick) return CLOSED
  return {
    show: true,
    real: Math.round(pick.distance / 10) * 10,
    step: `${pick.maneuver.node}:${pick.maneuver.turn}`,
    maneuver: pick.maneuver,
    following: pick.following,
  }
}

/** Whether the junction view is showing: the map's own split opens on it (MapSplit.tsx), and the panel draws
 * itself (JunctionView.tsx). Both read this one state (the geometry is cached; nothing else is repeated). No
 * map data, no panel either: the route may be known before the map's build is. */
export function useJunctionShown(): boolean {
  const data = useMapData()
  const junction = useLive((state) => junctionCardOf(state).show)
  return junction && data !== null && data !== undefined
}
