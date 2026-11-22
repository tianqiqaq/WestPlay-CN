import { useEffect, useRef, useState } from 'react'
import { IN_APP } from '../bridge'
import { Button, Group, Note, Panel, Row, Status, Switch } from '../room/parts'
import { GLOW, useScreenAt } from '../room/screen'
import { MIRROR_DEFAULT, MIRROR_PORT } from '../useSettings'
import type { PageProps } from './page'
import type { CompanionWords } from './words'
import './mirror.css'

/** How long a copied address says so. */
const COPIED_MS = 2000
/** How long a save says it's in effect. */
const APPLIED_MS = 2000

/**
 * Browser Access: the truck's screen also served by the host in a browser (`westplay_host`), on this PC and,
 * if allowed, on the network. Its addresses, how many pages show it, and the settings that start it: on or off,
 * the port, and whether other devices may open it. Saving hands them to the app (which restarts the mirror);
 * a change takes effect at once, and the status says where it's listening.
 */
export function MirrorPage({ status, settings: state, cw }: PageProps) {
  const w = cw.mirror
  const mirror = status?.mirror ?? null
  const saved = state.settings?.mirror
  const [enabled, setEnabled] = useState(saved?.enabled ?? MIRROR_DEFAULT.enabled)
  const [port, setPort] = useState(String(saved?.port ?? MIRROR_DEFAULT.port))
  const [lan, setLan] = useState(saved?.lan ?? MIRROR_DEFAULT.lan)
  const [copied, setCopied] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [applied, setApplied] = useState(false)
  // The settings saved last, as one value: a change from another window fills the form in, while the player's
  // own typing (not saved yet) stays as it is.
  const loaded = useRef('')
  useEffect(() => {
    if (!saved) return
    const key = `${saved.enabled}|${saved.port}|${saved.lan}`
    if (key === loaded.current) return
    loaded.current = key
    setEnabled(saved.enabled)
    setPort(String(saved.port))
    setLan(saved.lan)
  }, [saved])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])
  useEffect(() => {
    if (!applied) return
    const timer = window.setTimeout(() => setApplied(false), APPLIED_MS)
    return () => window.clearTimeout(timer)
  }, [applied])
  // The screen the mirror shows, in its room: Home, as this page is about WestPlay itself.
  useScreenAt('home', GLOW.home, null)

  const portNumber = Number(port)
  const portValid =
    /^\d+$/.test(port) &&
    Number.isInteger(portNumber) &&
    portNumber >= MIRROR_PORT.min &&
    portNumber <= MIRROR_PORT.max
  const filled = (text: string) =>
    text.replace('{min}', String(MIRROR_PORT.min)).replace('{max}', String(MIRROR_PORT.max))

  const copy = (url: string) => {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      console.error('The address could not be copied: no clipboard here')
      return
    }
    clipboard.writeText(url).then(
      () => setCopied(url),
      (error: unknown) => console.error('The address could not be copied', error),
    )
  }

  const save = () => {
    const current = state.settings
    if (!current || !portValid) return
    setSaving(true)
    setApplied(false)
    // `update` never rejects: a failure is kept in `error`, and the settings read back as they were.
    void state.update({ ...current, mirror: { enabled, port: portNumber, lan } }).finally(() => {
      setSaving(false)
      setApplied(true)
    })
  }

  return (
    <Panel
      place="page"
      title={w.title}
      sub={w.sub}
      action={
        <Button onClick={save} busy={saving} disabled={!portValid || !state.settings}>
          {w.save}
        </Button>
      }
    >
      {!status && <Note tone="calm">{cw.state.starting}</Note>}
      {status?.error && <Note tone="bad">{status.error}</Note>}
      {status && !status.error && !mirror && (
        <Note tone="calm">{saved?.enabled === false ? w.status.off : cw.state.starting}</Note>
      )}
      {mirror?.error && (
        <Note tone="bad">
          <b>{w.status.failed}</b> {mirror.error}
        </Note>
      )}
      {mirror && !mirror.error && (
        <Group title={w.status.running} place={4}>
          {mirror.localUrl && (
            <Address label={w.local} url={mirror.localUrl} words={w} copied={copied} copy={copy} />
          )}
          {mirror.lanUrl && <Address label={w.lan} url={mirror.lanUrl} words={w} copied={copied} copy={copy} />}
          <Row
            title={w.status.clients.replace('{n}', String(mirror.clients))}
            accessory={<Status tone={mirror.clients > 0 ? 'good' : 'idle'} />}
          />
        </Group>
      )}
      <Group title={w.settings} place={5}>
        <Row
          title={w.enable}
          detail={w.enableDetail}
          accessory={<Switch on={enabled} label={w.enable} change={setEnabled} />}
        />
        <div className="ob-row cp-mirror-port">
          <span className="ob-row-text">
            <b>{w.port}</b>
            <span className={portValid ? undefined : 'cp-mirror-invalid'}>
              {portValid ? filled(w.portDetail) : filled(w.portInvalid)}
            </span>
          </span>
          <input
            className="cp-mirror-field"
            type="number"
            inputMode="numeric"
            min={MIRROR_PORT.min}
            max={MIRROR_PORT.max}
            value={port}
            aria-label={w.port}
            aria-invalid={!portValid || undefined}
            onChange={(event) => setPort(event.target.value)}
          />
        </div>
        <Row
          title={w.lanOn}
          detail={w.lanDetail}
          accessory={<Switch on={lan} label={w.lanOn} change={setLan} />}
        />
      </Group>
      {state.error && <Note tone="bad">{w.saveFailed.replace('{error}', state.error)}</Note>}
      {applied && !state.error && <p className="cp-mirror-applied ob-in">{w.saved}</p>}
      <ul className="cp-mirror-notes ob-in">
        <li>{w.notes.sameScreen}</li>
        <li>{w.notes.sound}</li>
        <li>{w.notes.video}</li>
      </ul>
    </Panel>
  )
}

/** One address of the mirror: its words, its URL in a monospaced line, Copy, and (outside the app) Open. */
function Address({
  label,
  url,
  words,
  copied,
  copy,
}: {
  label: string
  url: string
  words: CompanionWords['mirror']
  copied: string | null
  copy(url: string): void
}) {
  return (
    <div className="ob-row cp-mirror-address">
      <span className="ob-row-text">
        <b>{label}</b>
        <code className="cp-mirror-url">{url}</code>
      </span>
      <span className="cp-mirror-buttons">
        <button type="button" onClick={() => copy(url)}>
          {copied === url ? words.copied : words.copy}
        </button>
        {/* A link would load in the companion's own window inside the app; the browser preview can open one. */}
        {!IN_APP && (
          <a href={url} target="_blank" rel="noreferrer">
            {words.open}
          </a>
        )}
      </span>
    </div>
  )
}
