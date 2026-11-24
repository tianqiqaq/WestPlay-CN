import { describe, expect, it } from 'vitest'
import { type Guidance, NOW_WITHIN } from './guidance'
import {
  bearingOfDirection,
  JUNCTION_AFTER_M,
  JUNCTION_BEFORE_M,
  JUNCTION_CHEVRON_SPACING,
  JUNCTION_MAX_M,
  junctionAhead,
  junctionViewOf,
} from './junctionView'
import type { Point, RouteNode } from './route'

/** A route through `positions` (game metres, x east z south): each node faces along the way through it. */
function routeOf(positions: Point[]): {
  nodes: RouteNode[]
  paths: Map<number, Point[]>
  shifts: Map<number, number>
} {
  const nodes: RouteNode[] = positions.map((position, index) => {
    const before = positions[Math.max(0, index - 1)]
    const after = positions[Math.min(positions.length - 1, index + 1)]
    const dx = after[0] - before[0]
    const dz = after[1] - before[1]
    const length = Math.hypot(dx, dz) || 1
    return { position, forward: [dx / length, dz / length] }
  })
  return { nodes, paths: new Map(), shifts: new Map() }
}

/** A turn at `node`, `distance` metres ahead. */
function turn(node: number, distance: number): Guidance {
  return { step: { kind: 'turn', maneuver: { node, turn: 'left', angle: -90, exit: null } }, distance, then: null }
}

/** The route's end. */
function arrive(distance: number): Guidance {
  return { step: { kind: 'arrive' }, distance, then: null }
}

/** The entry is due north from the junction, then east from the west: a right angle, entered from the south. */
const NORTHBOUND = routeOf([
  [0, 80],
  [0, 0],
  [0, -80],
])

describe('junctionAhead', () => {
  it('shows for a turn within reach, and only then', () => {
    expect(junctionAhead(turn(1, JUNCTION_MAX_M))).toBe(true)
    expect(junctionAhead(turn(1, JUNCTION_MAX_M + 1))).toBe(false)
    expect(junctionAhead(turn(1, NOW_WITHIN + 1))).toBe(true)
    // In the junction already ("now" on the card): the view gets out of the way.
    expect(junctionAhead(turn(1, NOW_WITHIN))).toBe(false)
    expect(junctionAhead(turn(1, 0))).toBe(false)
    expect(junctionAhead(turn(1, -10))).toBe(false)
  })

  it('shows nothing without a route, and nothing once arrived', () => {
    expect(junctionAhead(null)).toBe(false)
    expect(junctionAhead(arrive(100))).toBe(false)
  })
})

describe('junctionViewOf', () => {
  it('shows nothing without a turn in reach', () => {
    expect(junctionViewOf(NORTHBOUND, null)).toBeNull()
    expect(junctionViewOf(NORTHBOUND, arrive(100))).toBeNull()
    expect(junctionViewOf(NORTHBOUND, turn(1, JUNCTION_MAX_M + 1))).toBeNull()
    expect(junctionViewOf(NORTHBOUND, turn(1, NOW_WITHIN))).toBeNull()
  })

  it('shows nothing without a route to show', () => {
    expect(junctionViewOf({ nodes: [], paths: new Map(), shifts: new Map() }, turn(1, 100))).toBeNull()
    // The turn's node isn't one the route has.
    expect(junctionViewOf(routeOf([[0, 0]]), turn(1, 100))).toBeNull()
  })

  it('centres on the junction, with the route 80 m before it and 40 m after', () => {
    const view = junctionViewOf(NORTHBOUND, turn(1, 120))
    expect(view).not.toBeNull()
    if (!view) return
    expect(view.center).toEqual([0, 0])
    expect(view.distance).toBe(120)
    expect(view.line.length).toBeGreaterThan(2)
    const first = view.line[0]
    const last = view.line[view.line.length - 1]
    expect(first[0]).toBeCloseTo(0, 3)
    expect(first[1]).toBeCloseTo(JUNCTION_BEFORE_M, 0)
    expect(last[0]).toBeCloseTo(0, 3)
    expect(last[1]).toBeCloseTo(-JUNCTION_AFTER_M, 0)
    // The line runs the way the route does, never back: z falls all the way (northbound).
    view.line.forEach((point, index) => {
      if (index > 0) expect(point[1]).toBeLessThan(view.line[index - 1][1])
    })
  })

  it('cuts the ends short where the route has less before or after than asked', () => {
    // 30 m before the junction, 30 after: the slice is what the route has.
    const view = junctionViewOf(
      routeOf([
        [0, 30],
        [0, 0],
        [0, -30],
      ]),
      turn(1, 120),
    )
    expect(view).not.toBeNull()
    if (!view) return
    expect(view.line[0][1]).toBeCloseTo(30, 0)
    expect(view.line[view.line.length - 1][1]).toBeCloseTo(-30, 0)
  })

  it('faces the way the truck enters the junction, from every side', () => {
    const sides: { name: string; positions: Point[]; bearing: number }[] = [
      { name: 'from the south (northbound)', positions: [[0, 80], [0, 0], [0, -80]], bearing: 0 },
      { name: 'from the west (eastbound)', positions: [[-80, 0], [0, 0], [80, 0]], bearing: 90 },
      { name: 'from the north (southbound)', positions: [[0, -80], [0, 0], [0, 80]], bearing: 180 },
      { name: 'from the east (westbound)', positions: [[80, 0], [0, 0], [-80, 0]], bearing: 270 },
    ]
    for (const side of sides) {
      const view = junctionViewOf(routeOf(side.positions), turn(1, 120))
      expect(view, side.name).not.toBeNull()
      if (!view) continue
      const delta = Math.abs(((view.bearing - side.bearing + 540) % 360) - 180)
      expect(delta, `${side.name}: ${view.bearing}`).toBeLessThan(1)
    }
  })

  it('keeps the whole slice within the distances it was asked for', () => {
    const view = junctionViewOf(NORTHBOUND, turn(1, 200))
    if (!view) throw new Error('no view')
    for (const [x, z] of view.line) {
      expect(Math.abs(x)).toBeLessThan(0.01)
      expect(z).toBeGreaterThanOrEqual(-JUNCTION_AFTER_M - 0.01)
      expect(z).toBeLessThanOrEqual(JUNCTION_BEFORE_M + 0.01)
    }
  })

  it('takes its slice from a long route without building the whole route', () => {
    // A 100-node route heading north: node 50 is the junction at z = 0, and the view's slice is the 80 m
    // before it and 40 m after, as on the three-node routes.
    const positions: Point[] = Array.from({ length: 101 }, (_, index) => [0, 400 - index * 8])
    const view = junctionViewOf(routeOf(positions), turn(50, 200))
    if (!view) throw new Error('no view')
    expect(view.center).toEqual([0, 0])
    expect(view.line[0][1]).toBeCloseTo(JUNCTION_BEFORE_M, 0)
    expect(view.line[view.line.length - 1][1]).toBeCloseTo(-JUNCTION_AFTER_M, 0)
    const delta = Math.abs(((view.bearing + 540) % 360) - 180)
    expect(delta).toBeLessThan(1)
  })

  it('draws the lanes the host found at the junction', () => {
    const route = routeOf([[0, 80], [0, 0], [0, -80]])
    // The junction's own lanes (crates/mapdata junctions.rs): through this junction, a point at z = 40.
    route.paths.set(0, [[0, 80], [0, 40], [0, 0]])
    const view = junctionViewOf(route, turn(1, 120))
    if (!view) throw new Error('no view')
    expect(view.line.map(([, z]) => z)).toContain(40)
  })

  it('faces along the carriageway, not across from the node, on a road drawn as two', () => {
    const route = routeOf([[0, 80], [0, 0], [0, -80]])
    // 5 m right of the road's line at the junction: the route runs on the carriageway it drives on.
    route.shifts.set(1, 5)
    const view = junctionViewOf(route, turn(1, 120))
    if (!view) throw new Error('no view')
    const delta = Math.abs(((view.bearing + 540) % 360) - 180)
    expect(delta).toBeLessThan(5)
  })
})

describe('bearingOfDirection', () => {
  it('counts clockwise from north (the game: x east, z south)', () => {
    expect(bearingOfDirection(0, -1)).toBeCloseTo(0, 6)
    expect(bearingOfDirection(1, 0)).toBeCloseTo(90, 6)
    expect(bearingOfDirection(0, 1)).toBeCloseTo(180, 6)
    expect(bearingOfDirection(-1, 0)).toBeCloseTo(270, 6)
    // North-west is between: 315, never -45.
    const northWest = bearingOfDirection(-1, -1)
    expect(northWest).toBeGreaterThan(300)
    expect(northWest).toBeLessThan(330)
  })
})

describe('the junction view\'s constants', () => {
  it('keeps the arrows a readable distance apart, and the view ahead of the junction', () => {
    expect(JUNCTION_CHEVRON_SPACING).toBeGreaterThanOrEqual(20)
    expect(JUNCTION_CHEVRON_SPACING).toBeLessThanOrEqual(80)
    expect(JUNCTION_BEFORE_M).toBeGreaterThanOrEqual(40)
    expect(JUNCTION_AFTER_M).toBeGreaterThan(0)
    expect(JUNCTION_MAX_M).toBeGreaterThan(NOW_WITHIN)
  })
})
