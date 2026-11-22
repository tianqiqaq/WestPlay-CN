import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMessage, PageMessage } from './host'

/** What the page opened with `new EventSource`, as far as it uses one. */
interface FakeSource {
  url: string
  onmessage: ((event: { data: string }) => void) | null
  closed: boolean
  close(): void
}

/** A stand-in for the browser's `EventSource`: each source the page opens is kept, so a test can play the host by
 * calling its listener (and check that unsubscribing closed it). */
function fakeEventSources() {
  const opened: FakeSource[] = []
  class StandIn implements FakeSource {
    url: string
    onmessage: ((event: { data: string }) => void) | null = null
    closed = false
    constructor(url: string) {
      this.url = url
      opened.push(this)
    }
    close(): void {
      this.closed = true
    }
  }
  return { opened, StandIn }
}

/** The browser globals a page the host mirrors to a plain browser has: the host's marker, the mirror server's
 * origin, an `EventSource` and a `fetch` that records what the page posts. */
function mirrorPage(port = 35421) {
  const origin = `http://127.0.0.1:${port}`
  const eventSource = fakeEventSources()
  const posted: PageMessage[] = []
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    posted.push(JSON.parse(String(init?.body)) as PageMessage)
    return Promise.resolve()
  })
  vi.stubGlobal('window', { __WESTPLAY_MIRROR__: { port } })
  vi.stubGlobal('location', { origin, search: '' })
  vi.stubGlobal('EventSource', eventSource.StandIn)
  vi.stubGlobal('fetch', fetchMock)
  return { origin, ...eventSource, posted, calls, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a page the host mirrors to a plain browser', () => {
  it('is the host, with the marker the host writes into it', async () => {
    mirrorPage()
    const host = await import('./host')
    expect(host.isMirrored()).toBe(true)
    expect(host.isInHost()).toBe(true)
  })

  it('subscribes over Server-Sent Events, and says it is ready', async () => {
    const page = mirrorPage()
    const host = await import('./host')
    const seen: HostMessage[] = []
    const stop = host.subscribeHostMessages((message) => seen.push(message))

    expect(page.opened).toHaveLength(1)
    expect(page.opened[0]?.url).toBe('/api/events')
    // Ready at once, as a POST to the mirror server.
    expect(page.posted).toEqual([{ type: 'ready' }])
    expect(page.calls[0]?.url).toBe('/api/page')
    expect(page.calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ready' }),
      keepalive: true,
    })

    // Each event is one host message...
    page.opened[0]?.onmessage?.({ data: JSON.stringify({ type: 'screen', layout: null }) })
    expect(seen).toEqual([{ type: 'screen', layout: null }])
    // ...and a message it can't read is dropped, not thrown.
    expect(() => page.opened[0]?.onmessage?.({ data: 'not json' })).not.toThrow()
    expect(seen).toHaveLength(1)

    // Unsubscribing closes the stream.
    stop()
    expect(page.opened[0]?.closed).toBe(true)
  })

  it('posts page messages as POST /api/page, without waiting for the answer', async () => {
    const page = mirrorPage()
    const host = await import('./host')
    host.postToHost({ type: 'startup', stage: 'power on' })
    expect(page.posted).toEqual([{ type: 'startup', stage: 'power on' }])
    expect(page.calls).toEqual([
      {
        url: '/api/page',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'startup', stage: 'power on' }),
          keepalive: true,
        },
      },
    ])
  })

  it('asks for the player files on its own origin, read when asked', async () => {
    const page = mirrorPage()
    const bases = await import('./bases')
    expect(bases.mapsBase()).toBe(`${page.origin}/maps`)
    expect(bases.customizeBase()).toBe(`${page.origin}/customize/`)
    expect(bases.coversBase()).toBe(`${page.origin}/music-covers/`)

    // Not fixed when the module loaded: the origin is read each time.
    vi.stubGlobal('location', { origin: 'http://10.0.0.5:35421', search: '' })
    expect(bases.mapsBase()).toBe('http://10.0.0.5:35421/maps')
  })

  it("is never the demo's page, even with the marker in it", async () => {
    vi.stubGlobal('window', { __WESTPLAY_MIRROR__: { port: 1 } })
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:1', search: '?demo' })
    const host = await import('./host')
    expect(host.IS_DEMO).toBe(true)
    expect(host.isMirrored()).toBe(false)
    expect(host.isInHost()).toBe(false)
  })
})

describe('a plain browser page', () => {
  it('is not the host, and asks for nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('fetch', fetchMock)
    const host = await import('./host')
    const stop = host.subscribeHostMessages(() => {})
    expect(host.isMirrored()).toBe(false)
    expect(host.isInHost()).toBe(false)
    host.postToHost({ type: 'ready' })
    stop()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("takes the player files from the host's virtual hosts, without reading the origin", async () => {
    // No `origin` on the location: this branch (a plain page, a test) never needs one.
    vi.stubGlobal('location', { search: '' })
    const bases = await import('./bases')
    expect(bases.mapsBase()).toBe('https://westplay.maps')
    expect(bases.customizeBase()).toBe('https://westplay.customize/')
    expect(bases.coversBase()).toBe('https://westplay.music-covers/')
  })
})
