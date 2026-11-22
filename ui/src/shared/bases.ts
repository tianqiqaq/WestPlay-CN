import { isMirrored } from './host'

/**
 * Where the cabin page finds the player's files: WestPlay's built maps, the player's wallpapers and icon sets
 * (the companion's Customize), and their songs' covers.
 *
 * In WestPlay the host serves them from WebView2's virtual hosts (`https://westplay.maps`,
 * `https://westplay.customize/`, `https://westplay.music-covers/`), which a plain browser has no way to resolve. A
 * page the host mirrors to a plain browser (host.ts `isMirrored`) is served by the host's own mirror server, which
 * answers the same files from paths on its own origin (crates/host mirror.rs).
 *
 * Read lazily, inside each function: a mirrored page knows its origin only in the browser, and tests (a node
 * environment) have no `location` at all. The host's branches never touch it.
 */
export function mapsBase(): string {
  return isMirrored() ? `${location.origin}/maps` : 'https://westplay.maps'
}

export function customizeBase(): string {
  return isMirrored() ? `${location.origin}/customize/` : 'https://westplay.customize/'
}

export function coversBase(): string {
  return isMirrored() ? `${location.origin}/music-covers/` : 'https://westplay.music-covers/'
}
