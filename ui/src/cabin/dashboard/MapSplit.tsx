import { JunctionView } from './JunctionView'
import { useJunctionShown } from './junctionCard'
import { MapView } from './MapView'

/**
 * The map, split: the junction view over the map while a turn is near (JunctionView.tsx), the map alone
 * otherwise (MapView.tsx). One component for the Dashboard and the Maps app, so both behave alike — the map is
 * squeezed to the lower half while the junction panel is up, in one motion (map.css).
 *
 * The panel decides its own showing (`useJunctionShown`); the split only says whether it's up, for the layout.
 * Both read the same state (the geometry is cached in junctionView.ts), and neither draws anything of its own.
 */
export function MapSplit({ interactive = false }: { interactive?: boolean }) {
  const junction = useJunctionShown()
  return (
    <div className="map-split" data-junction={junction ? '' : undefined}>
      <JunctionView />
      <MapView interactive={interactive} />
    </div>
  )
}
