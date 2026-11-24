import { describe, expect, it } from 'vitest'
import type { Guidance, TurnKind } from './guidance'
import {
  bearingOfDirection,
  facingOfHeading,
  JUNCTION_AFTER_M,
  JUNCTION_BEFORE_M,
  JUNCTION_CHEVRON_SPACING,
  JUNCTION_MAX_M,
  JUNCTION_NOW_M,
  junctionAhead,
  junctionRealDistance,
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

/** A turn at `node`, `distance` of the GPS's metres ahead (its game distances, about 19 or 3 of them to the
 * road's one). */
function turn(node: number, distance: number, kind: TurnKind = 'left'): Guidance {
  return { step: { kind: 'turn', maneuver: { node, turn: kind, angle: -90, exit: null } }, distance, then: null }
}

/** The route's end. */
function arrive(distance: number): Guidance {
  return { step: { kind: 'arrive' }, distance, then: null }
}

/** A straight route heading north: node `index` at z = 400 - 8 * index, from z = 400 to z = -200. */
const STRAIGHT_Z = (index: number) => 400 - index * 8
const STRAIGHT = routeOf(Array.from({ length: 76 }, (_, index) => [0, STRAIGHT_Z(index)]))
/** The junction on `STRAIGHT`: z = 0. */
const JUNCTION = 50

/** The node ahead of a truck at `z` on `STRAIGHT` (z falls as the route runs north). */
function aheadOf(z: number): number {
  return Math.max(0, Math.min(75, Math.ceil((400 - z) / 8)))
}

/** The bearing difference from due north (0), for assertions that don't care about the wrap. */
function northDelta(bearing: number): number {
  return Math.abs(((bearing + 540) % 360) - 180)
}

describe('junctionAhead', () => {
  it('shows from the real road distance: past the junction, and short of the limit', () => {
    expect(junctionAhead(JUNCTION_MAX_M)).toBe(true)
    expect(junctionAhead(JUNCTION_MAX_M + 1)).toBe(false)
    expect(junctionAhead(JUNCTION_NOW_M + 1)).toBe(true)
    // In the junction already: the view gets out of the way.
    expect(junctionAhead(JUNCTION_NOW_M)).toBe(false)
    expect(junctionAhead(0)).toBe(false)
    expect(junctionAhead(-10)).toBe(false)
  })

  it('shows nothing where there is no distance at all (no route, arriving, or no truck place yet)', () => {
    expect(junctionAhead(null)).toBe(false)
  })
})

describe('junctionRealDistance', () => {
  it('measures the road, however large the GPS makes the turn sound', () => {
    // 300 m of road before the junction, which the GPS calls 5.7 km (out of town it counts ~19 of its metres
    // to the road's one): this is what the 350-m game-distance window missed.
    const truck: [number, number] = [0, 300]
    const real = junctionRealDistance(STRAIGHT, turn(JUNCTION, 5700), truck, facingOfHeading(0.5), aheadOf(300))
    expect(real).not.toBeNull()
    expect(real ?? 0).toBeCloseTo(300, 1)
    expect(junctionAhead(real)).toBe(true)
  })

  it('hides a turn beyond the limit of the road, however close the GPS says it is', () => {
    // 400 m of road before the junction (the GPS calls it 1 km).
    const truck: [number, number] = [0, 400]
    const real = junctionRealDistance(STRAIGHT, turn(JUNCTION, 1000), truck, facingOfHeading(0.5), aheadOf(400))
    expect(real).not.toBeNull()
    expect(real ?? 0).toBeGreaterThanOrEqual(400)
    expect(junctionAhead(real)).toBe(false)
  })

  it('shows ramps and keeps: exits and keep-lefts are turns like any other', () => {
    const truck: [number, number] = [0, 300]
    for (const kind of ['exit-right', 'exit-left', 'keep-right', 'keep-left'] as const) {
      const real = junctionRealDistance(STRAIGHT, turn(JUNCTION, 4800, kind), truck, facingOfHeading(0.5), aheadOf(300))
      expect(real, kind).not.toBeNull()
      expect(junctionAhead(real), kind).toBe(true)
    }
  })

  it('hides the turn once the truck is through the junction', () => {
    const truck: [number, number] = [0, -50]
    const real = junctionRealDistance(STRAIGHT, turn(JUNCTION, 0), truck, facingOfHeading(0.5), aheadOf(-50))
    expect(real).toBeNull()
  })

  it('shows nothing without a turn', () => {
    const truck: [number, number] = [0, 300]
    expect(junctionRealDistance(STRAIGHT, null, truck, facingOfHeading(0.5), aheadOf(300))).toBeNull()
    expect(junctionRealDistance(STRAIGHT, arrive(5700), truck, facingOfHeading(0.5), aheadOf(300))).toBeNull()
    // A turn on a node the route doesn't have.
    expect(junctionRealDistance(routeOf([[0, 0]]), turn(1, 100), truck, facingOfHeading(0.5), 0)).toBeNull()
  })

  it('follows the route around its curves, not the straight line to the junction', () => {
    // East 100 m, then north 100 m to the junction: about 200 m of road (the game's own curve into the turn
    // adds a few), but only ~141 m as the crow flies.
    const route = routeOf([[-100, 100], [0, 100], [0, 0]])
    const truck: [number, number] = [-100, 100]
    const real = junctionRealDistance(route, turn(2, 3800), truck, facingOfHeading(0.75), 1)
    expect(real ?? 0).toBeGreaterThan(190)
    expect(real ?? 0).toBeLessThan(215)
    expect(junctionAhead(real)).toBe(true)
  })
})

describe('facingOfHeading', () => {
  it('turns the game\'s heading into a direction on the ground (turns, 0 = north, counter-clockwise)', () => {
    const near = (actual: Point, dx: number, dz: number) => {
      expect(actual[0]).toBeCloseTo(dx, 6)
      expect(actual[1]).toBeCloseTo(dz, 6)
    }
    near(facingOfHeading(0), 0, -1)
    near(facingOfHeading(0.25), -1, 0)
    near(facingOfHeading(0.5), 0, 1)
    near(facingOfHeading(0.75), 1, 0)
  })
})

describe('junctionViewOf', () => {
  it('shows no picture without a turn or a node to show', () => {
    expect(junctionViewOf(STRAIGHT, null)).toBeNull()
    expect(junctionViewOf(STRAIGHT, arrive(100))).toBeNull()
    expect(junctionViewOf({ nodes: [], paths: new Map(), shifts: new Map() }, turn(1, 100))).toBeNull()
    // The turn's node isn't one the route has.
    expect(junctionViewOf(routeOf([[0, 0]]), turn(1, 100))).toBeNull()
  })

  it('is drawn however far the GPS says the turn is: its showing is the real distance\'s', () => {
    expect(junctionViewOf(STRAIGHT, turn(JUNCTION, 5700))).not.toBeNull()
  })

  it('centres on the junction, with the route 80 m before it and 40 m after', () => {
    const view = junctionViewOf(STRAIGHT, turn(JUNCTION, 120))
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
    const view = junctionViewOf(routeOf([[0, 30], [0, 0], [0, -30]]), turn(1, 120))
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
    const view = junctionViewOf(STRAIGHT, turn(JUNCTION, 200))
    if (!view) throw new Error('no view')
    for (const [x, z] of view.line) {
      expect(Math.abs(x)).toBeLessThan(0.01)
      expect(z).toBeGreaterThanOrEqual(-JUNCTION_AFTER_M - 0.01)
      expect(z).toBeLessThanOrEqual(JUNCTION_BEFORE_M + 0.01)
    }
  })

  it('takes its slice from a long route without building the whole route', () => {
    const positions: Point[] = Array.from({ length: 101 }, (_, index) => [0, STRAIGHT_Z(index)])
    const view = junctionViewOf(routeOf(positions), turn(JUNCTION, 200))
    if (!view) throw new Error('no view')
    expect(view.center).toEqual([0, 0])
    expect(view.line[0][1]).toBeCloseTo(JUNCTION_BEFORE_M, 0)
    expect(view.line[view.line.length - 1][1]).toBeCloseTo(-JUNCTION_AFTER_M, 0)
    expect(northDelta(view.bearing)).toBeLessThan(1)
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
    expect(northDelta(view.bearing)).toBeLessThan(5)
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

describe("the junction view's constants", () => {
  it('keeps the arrows a readable distance apart, and the view measured in the road\'s own metres', () => {
    expect(JUNCTION_CHEVRON_SPACING).toBeGreaterThanOrEqual(20)
    expect(JUNCTION_CHEVRON_SPACING).toBeLessThanOrEqual(80)
    expect(JUNCTION_BEFORE_M).toBeGreaterThanOrEqual(40)
    expect(JUNCTION_AFTER_M).toBeGreaterThan(0)
    expect(JUNCTION_NOW_M).toBeGreaterThan(0)
    expect(JUNCTION_MAX_M).toBeGreaterThan(JUNCTION_NOW_M)
  })
})
