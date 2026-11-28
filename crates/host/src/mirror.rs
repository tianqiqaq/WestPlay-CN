//! The cabin page's frames mirrored on a local port: the very picture the truck's screen shows, for the player's
//! phone or tablet beside it, and their mouse on it taken back into the page.
//!
//! There is no second page here: the host's WebView is drawn once, and the frames the game takes are copied out of
//! the shared texture ([`crate::capture`]) as BGRA, encoded to JPEG on a thread of this module, and served to the
//! viewer page ([`VIEWER`]) a frame at a time (`GET /api/frame`). The mouse the viewer takes on that picture comes
//! back as `POST /api/input`, and the host sends it into the page at the frame's point
//! ([`crate::run`]'s `send_mirror_input`), so what's clicked is what's shown.
//!
//! It listens on 127.0.0.1, or on every adapter when the player turns the LAN on: then, on the same Wi-Fi, a phone
//! shows the screen too. No page's files are served: only the viewer's own HTML, its frames and the mouse.
//!
//! Frames are read back only while a viewer is asking for them ([`watching`]) and the settings' rate hasn't been
//! reached yet ([`wants_frame`]), and are encoded only when one has changed (the latest raw frame is all that's
//! kept): an idle screen, or none watching, costs nothing.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::net::{IpAddr, UdpSocket};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use image::ExtendedColorType;
use image::codecs::jpeg::JpegEncoder;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::settings::MirrorSettings;

/// The frame the cabin page is captured at: the screen the game copies into its textures.
const FRAME_WIDTH: u32 = westplay_shared::SCREEN_WIDTH;
const FRAME_HEIGHT: u32 = westplay_shared::SCREEN_HEIGHT;

/// The most of a mouse event's body read (`POST /api/input`).
const INPUT_BODY_MAX: u64 = 4 * 1024;

/// The mouse events waiting for the host: the newest kept if more come than it takes.
const INPUTS_MAX: usize = 64;

/// How long a frame request waits for a newer frame before it's told there is none (204), and asks again.
const FRAME_WAIT: Duration = Duration::from_millis(1500);

/// How long a viewer counts after its last request (`Status`'s `clients`, [`watching`]): a closed tab asks no more.
const CLIENT_KEEP: Duration = Duration::from_secs(5);

/// What the mirrored screen is served from: the settings the listener was started with (the frames' quality and rate
/// are read when they're encoded, so they change without a restart).
pub struct Mirror {
    server: Arc<Server>,
    accept: Mutex<Option<thread::JoinHandle<()>>>,
    pub port: u16,
    pub lan: bool,
    /// The viewer, as a browser on this PC opens it.
    pub local_url: String,
    /// The same at this PC's address on the network (`None`: the LAN is off, or the PC has no address to find).
    pub lan_url: Option<String>,
    /// `None` while it runs (nothing sets it yet): a start that failed has no `Mirror`, and its reason is the
    /// status's error instead (`MirrorStatus::error`, made by `lib`'s `mirror_status`). Kept for a listener that
    /// stops after starting.
    pub error: Option<String>,
}

/// What a request is answered from: the listener's port and network, as the viewer's page is told (`GET /api/info`).
struct Context {
    port: u16,
    lan: bool,
}

/// A captured frame waiting to be encoded, and the newer one that would replace it.
struct Raw {
    /// The frame's number, the viewer's `after` (`X-Seq` in the answer).
    seq: u64,
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

/// One slot, and the threads waiting for something to be put in it: a new raw frame for the encoder, a new JPEG
/// for the frame requests. Only the newest is kept.
struct Inbox<T> {
    slot: Mutex<Option<T>>,
    ready: Condvar,
}

impl<T> Inbox<T> {
    fn new() -> Self {
        Self { slot: Mutex::new(None), ready: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Option<T>> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait<'a>(&self, slot: MutexGuard<'a, Option<T>>) -> MutexGuard<'a, Option<T>> {
        self.ready.wait(slot).unwrap_or_else(|e| e.into_inner())
    }

    fn wait_timeout<'a>(&self, slot: MutexGuard<'a, Option<T>>, timeout: Duration) -> MutexGuard<'a, Option<T>> {
        self.ready.wait_timeout(slot, timeout).unwrap_or_else(|e| e.into_inner()).0
    }

    fn notify(&self) {
        self.ready.notify_all();
    }
}

/// The frames captured and waiting to be encoded (the newest only), and the frames encoded and waiting for the
/// viewers (the newest, with its number).
static RAW: OnceLock<Inbox<Raw>> = OnceLock::new();
static LATEST: OnceLock<Inbox<(u64, Arc<Vec<u8>>)>> = OnceLock::new();

/// The frame being read back, its number.
static SEQ: AtomicU64 = AtomicU64::new(1);

/// The frames' quality and rate (`Arc<AtomicU8>` as the settings say: written as they change, read as frames go).
static QUALITY: AtomicU8 = AtomicU8::new(crate::settings::DEFAULT_MIRROR_QUALITY);
static FPS: AtomicU8 = AtomicU8::new(crate::settings::DEFAULT_MIRROR_FPS);

/// When the last frame was read back, for [`wants_frame`].
static READ_BACK: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

/// The viewers that asked for a frame lately, by their own id: their number is the status's `clients`.
static CLIENTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

/// The mouse events the viewers sent, for the host to take ([`take_inputs`]).
static INPUTS: OnceLock<Mutex<VecDeque<InputEvent>>> = OnceLock::new();

/// The page as the game has it laid out, and the rows its frame carries it in (`PagePlace`): the viewer draws the
/// frame at the page's own shape, so the phone's picture is the truck's screen's and not a squashed copy of it.
static PAGE: OnceLock<Mutex<(u32, u32, u32)>> = OnceLock::new();

fn page() -> &'static Mutex<(u32, u32, u32)> {
    PAGE.get_or_init(|| Mutex::new((FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEIGHT)))
}

/// The page's shape as the game's screen has it: its width, its height, and the rows the frame carries it in.
pub fn set_page(width: u32, height: u32, rows: u32) {
    *page().lock().unwrap_or_else(|e| e.into_inner()) = (width.max(1), height.max(1), rows.max(1));
}

/// The page as the viewer should have it: the game's strips cut off (`crop`), so what it shows is the page's own
/// area, its whole.
fn page_shape() -> (u32, u32, u32) {
    let (width, height, rows) = *page().lock().unwrap_or_else(|e| e.into_inner());
    let (left, bottom) = *crop().lock().unwrap_or_else(|e| e.into_inner());
    let left = left.min(width.saturating_sub(1));
    let bottom = bottom.min(height.saturating_sub(1));
    let bottom_rows = ((u64::from(bottom) * u64::from(rows)) / u64::from(height.max(1))) as u32;
    (width - left, height - bottom, rows.saturating_sub(bottom_rows).max(1))
}

/// The game's strips in the frame's pixels: the left across, the bottom down (0, 0 for none): what the mirror
/// reads back, the rest of the frame cut off.
pub fn crop_frame() -> (u32, u32) {
    let (width, height, rows) = *page().lock().unwrap_or_else(|e| e.into_inner());
    let (left, bottom) = *crop().lock().unwrap_or_else(|e| e.into_inner());
    let left = left.min(width.saturating_sub(1));
    let bottom_rows = ((u64::from(bottom) * u64::from(rows)) / u64::from(height.max(1))) as u32;
    (left, bottom_rows.min(rows.saturating_sub(1)))
}

/// How much of the page the game's own strips take (0, 0 when there are none): `left` in the page's pixels,
/// `bottom` in the page's rows (as the game lays it out: `set_page`).
pub fn set_crop(left: u32, bottom: u32) {
    *crop().lock().unwrap_or_else(|e| e.into_inner()) = (left, bottom);
}

fn crop() -> &'static Mutex<(u32, u32)> {
    CROP.get_or_init(|| Mutex::new((0, 0)))
}

/// The mirror's own crop of the page's strips: `left` across, `bottom` down, both in the page's own pixels/rows.
static CROP: OnceLock<Mutex<(u32, u32)>> = OnceLock::new();

fn raw() -> &'static Inbox<Raw> {
    RAW.get_or_init(Inbox::new)
}

fn latest() -> &'static Inbox<(u64, Arc<Vec<u8>>)> {
    LATEST.get_or_init(Inbox::new)
}

fn read_back_at() -> &'static Mutex<Option<Instant>> {
    READ_BACK.get_or_init(|| Mutex::new(None))
}

fn clients() -> &'static Mutex<HashMap<String, Instant>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn inputs() -> &'static Mutex<VecDeque<InputEvent>> {
    INPUTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Starts serving the frames on `settings`'s port, on 127.0.0.1 or (the LAN on) on every adapter. The caller stops
/// the previous mirror first: it may hold the same port.
pub fn start(settings: &MirrorSettings) -> Result<Mirror, String> {
    configure(settings);
    let address =
        if settings.lan { format!("0.0.0.0:{}", settings.port) } else { format!("127.0.0.1:{}", settings.port) };
    let server = Server::http(address.as_str()).map_err(|error| format!("can't listen on {address}: {error}"))?;
    encode_frames();
    let server = Arc::new(server);
    let context = Arc::new(Context { port: settings.port, lan: settings.lan });
    let serving = server.clone();
    let accept = thread::Builder::new()
        .name("mirror".into())
        .spawn(move || {
            // A request that panics (a bug) mustn't take the listener with it: each is caught, its connection
            // dropped. The listener's own panic is caught too: nothing unwinds out of a thread here.
            let _ = catch_unwind(AssertUnwindSafe(|| {
                for request in serving.incoming_requests() {
                    let context = context.clone();
                    let _ = thread::Builder::new().name("mirror request".into()).spawn(move || {
                        let _ = catch_unwind(AssertUnwindSafe(|| serve(request, &context)));
                    });
                }
            }));
        })
        .map_err(|error| format!("can't start the mirror's thread: {error}"))?;
    let lan_url = if settings.lan {
        lan_address().map(|address| format!("http://{address}:{}/cabin.html", settings.port))
    } else {
        None
    };
    Ok(Mirror {
        server,
        accept: Mutex::new(Some(accept)),
        port: settings.port,
        lan: settings.lan,
        local_url: format!("http://127.0.0.1:{}/cabin.html", settings.port),
        lan_url,
        error: None,
    })
}

impl Mirror {
    /// How many viewers asked for a frame lately.
    pub fn clients(&self) -> usize {
        client_count()
    }

    /// Stops the listener: `unblock` is how tiny_http ends an `incoming_requests` loop from another thread, and
    /// the accept thread joins after it. Nothing is watched or encoded any more once it's gone.
    pub fn stop(&self) {
        self.server.unblock();
        clients().lock().unwrap_or_else(|e| e.into_inner()).clear();
        *raw().lock() = None;
        *latest().lock() = None;
        if let Some(accept) = self.accept.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = accept.join();
        }
    }
}

impl Drop for Mirror {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The frames' quality and rate from now on, as the settings changed (no restart: the encoder reads them).
pub fn configure(settings: &MirrorSettings) {
    let quality = settings.quality.clamp(MirrorSettings::MIN_QUALITY, MirrorSettings::MAX_QUALITY);
    let fps = settings.fps.clamp(MirrorSettings::MIN_FPS, MirrorSettings::MAX_FPS);
    QUALITY.store(quality, Ordering::Relaxed);
    FPS.store(fps, Ordering::Relaxed);
}

/// Whether someone is watching the screen now (a viewer asked for a frame within [`CLIENT_KEEP`]).
pub fn watching() -> bool {
    client_count() > 0
}

/// How many viewers asked for a frame within [`CLIENT_KEEP`].
fn client_count() -> usize {
    let mut clients = clients().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    clients.retain(|_, asked| now.saturating_duration_since(*asked) <= CLIENT_KEEP);
    clients.len()
}

/// Whether the frames' rate allows another one to be read back now (the last was at least 1/[`FPS`] ago).
pub fn wants_frame() -> bool {
    let interval = Duration::from_secs_f32(1.0 / f32::from(FPS.load(Ordering::Relaxed).max(1)));
    let read_back = read_back_at().lock().unwrap_or_else(|e| e.into_inner());
    read_back.is_none_or(|at| at.elapsed() >= interval)
}

/// A new frame of the screen's, as BGRA, from the host's capture (called with the shared texture's lock held): the
/// encoder takes it, and the viewers get it when it's a JPEG.
pub fn publish_frame(width: u32, height: u32, bgra: &[u8]) {
    *read_back_at().lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let inbox = raw();
    {
        let mut raw = inbox.lock();
        let fits = |frame: &Raw| frame.width == width && frame.height == height && frame.bgra.len() == bgra.len();
        if let Some(frame) = raw.as_mut() {
            if fits(frame) {
                frame.seq = seq;
                frame.bgra.copy_from_slice(bgra);
            } else {
                *frame = Raw { seq, width, height, bgra: bgra.to_vec() };
            }
        } else {
            *raw = Some(Raw { seq, width, height, bgra: bgra.to_vec() });
        }
    }
    inbox.notify();
}

/// The mouse events the viewers sent since the last call, oldest first.
pub fn take_inputs() -> Vec<InputEvent> {
    inputs().lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect()
}

/// One mouse event of the mirrored page: its point the frame's pixels (0 to 1279 across, 0 to 719 down), as the
/// viewer sends it after working the picture out.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    Move { x: i32, y: i32 },
    Down { x: i32, y: i32, button: Button },
    Up { x: i32, y: i32, button: Button },
    Wheel { x: i32, y: i32, delta: i32 },
}

/// Which of the mouse's buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl InputEvent {
    /// The event kept on the frame: a point past an edge takes the edge's pixel.
    fn clamped(self) -> Self {
        let (width, height) = (FRAME_WIDTH as i32 - 1, FRAME_HEIGHT as i32 - 1);
        let point = |x: i32, y: i32| (x.clamp(0, width), y.clamp(0, height));
        match self {
            Self::Move { x, y } => {
                let (x, y) = point(x, y);
                Self::Move { x, y }
            }
            Self::Down { x, y, button } => {
                let (x, y) = point(x, y);
                Self::Down { x, y, button }
            }
            Self::Up { x, y, button } => {
                let (x, y) = point(x, y);
                Self::Up { x, y, button }
            }
            Self::Wheel { x, y, delta } => {
                let (x, y) = point(x, y);
                Self::Wheel { x, y, delta }
            }
        }
    }
}

/// Starts the encoder thread, once: the settings' frames go out from it, the host's loop only leaves frames for it.
fn encode_frames() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = thread::Builder::new().name("mirror encoder".into()).spawn(encode_loop);
    });
}

/// Encodes the newest raw frame, at the settings' rate and quality, for the viewers waiting.
fn encode_loop() {
    let raw = raw();
    let latest = latest();
    let mut rgb = Vec::new();
    loop {
        let frame = {
            let mut slot = raw.lock();
            loop {
                if let Some(frame) = slot.take() {
                    break frame;
                }
                slot = raw.wait(slot);
            }
        };
        // Encoded as soon as a frame is read (the read-back's own cap is the settings' frames a second): no wait
        // here, so a frame never queues behind the last one's turn.
        let frame = {
            let mut slot = raw.lock();
            slot.take().unwrap_or(frame)
        };
        let quality = QUALITY.load(Ordering::Relaxed).clamp(MirrorSettings::MIN_QUALITY, MirrorSettings::MAX_QUALITY);
        let Some(jpeg) = jpeg(frame.width, frame.height, &frame.bgra, quality, &mut rgb) else { continue };
        {
            let mut slot = latest.lock();
            *slot = Some((frame.seq, Arc::new(jpeg)));
        }
        latest.notify();
    }
}

/// The frame as a JPEG (`None`: not the frame's size as BGRA, or the encoder refused it, and the next is taken).
fn jpeg(width: u32, height: u32, bgra: &[u8], quality: u8, rgb: &mut Vec<u8>) -> Option<Vec<u8>> {
    if bgra.len() != width as usize * height as usize * 4 {
        return None;
    }
    rgb.clear();
    rgb.reserve((width as usize * height as usize) * 3);
    for pixel in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode(rgb.as_slice(), width, height, ExtendedColorType::Rgb8)
        .ok()?;
    Some(jpeg)
}

fn serve(request: Request, context: &Context) {
    let url = request.url().to_owned();
    let path = url.split('?').next().unwrap_or_default().to_owned();
    if request.method() == &Method::Post {
        if path == "/api/input" {
            post_input(request);
        } else {
            let _ = request.respond(Response::empty(StatusCode(405)));
        }
        return;
    }
    if request.method() != &Method::Get {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }
    match path.as_str() {
        "/" | "/cabin.html" => respond_html(request),
        "/api/info" => info(request, context),
        "/api/frame" => frame(request, &url),
        _ => {
            let _ = request.respond(Response::empty(StatusCode(404)));
        }
    }
}

/// The viewer itself: a black page showing the frames, its mouse sent back. Two lines of text until the first
/// frame comes (no i18n: this page is the mirror's own, not the cabin page's).
const VIEWER: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>WestPlay</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:none}
canvas{position:fixed;cursor:none;pointer-events:auto;background:#000}
#hint{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5em;color:#9aa4ad;font:15px/1.5 system-ui,sans-serif;text-align:center;pointer-events:none}
#hint[hidden]{display:none}
</style>
</head>
<body>
<canvas id="frame"></canvas>
<div id="hint">Waiting for the truck's screen…<br>正在等待车机画面…</div>
<script>
(() => {
  'use strict';
  const W = 1280, H = 720;
  // The page the truck's screen shows, and the rows the frame carries it in (the host's PagePlace): the picture is
  // drawn at the page's own shape, so it isn't squashed the way a 16:9 window would squash it.
  let shapeW = W, shapeH = H, shapeRows = H;
  const canvas = document.getElementById('frame');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const hint = document.getElementById('hint');
  const key = 'westplayMirrorId';
  let id = null;
  try {
    id = sessionStorage.getItem(key);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, id);
    }
  } catch (e) {
    // Storage refused (a private tab): a name for this page alone.
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  let seq = 0;
  let drawn = 0;
  let inFlight = 0;
  // How many frames' requests may be out at once: one coming while the last decodes keeps the screen moving.
  const IN_FLIGHT = 2;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function layout() {
    // Filled, not fitted: the picture covers the page, its edges cropped rather than left as black bands (the
    // phone or tablet in landscape has another shape than the truck's screen, and this one's whole width shows).
    const scale = Math.max(window.innerWidth / shapeW, window.innerHeight / shapeH);
    const w = Math.max(1, Math.round(shapeW * scale));
    const h = Math.max(1, Math.round(shapeH * scale));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
    canvas.style.top = Math.round((window.innerHeight - h) / 2) + 'px';
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }
  function draw(bitmap) {
    // The frame's rows are the page squeezed into them: drawing it over the page's shape puts it back.
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    hint.hidden = true;
  }
  async function one() {
    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    try {
      const response = await fetch('/api/frame?after=' + seq + '&id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!response.ok) {
        // 204: nothing new yet; else the server is away for a moment.
        release();
        if (response.status !== 204) await sleep(400);
        return;
      }
      const got = Number(response.headers.get('X-Seq') || seq + 1);
      const pageW = Number(response.headers.get('X-Page-Width') || 0);
      const pageH = Number(response.headers.get('X-Page-Height') || 0);
      const rows = Number(response.headers.get('X-Frame-Rows') || 0);
      if (pageW && pageH && rows && (pageW !== shapeW || pageH !== shapeH || rows !== shapeRows)) {
        shapeW = pageW;
        shapeH = pageH;
        shapeRows = rows;
        layout();
      }
      const blob = await response.blob();
      // The next request goes out before this frame decodes: decoding overlaps the wait.
      release();
      pump();
      if (got <= drawn) return;
      const bitmap = await createImageBitmap(blob);
      drawn = got;
      seq = Math.max(seq, got);
      draw(bitmap);
      bitmap.close();
    } catch (e) {
      release();
      await sleep(400);
    } finally {
      pump();
    }
  }
  function pump() {
    while (inFlight < IN_FLIGHT) void one();
  }
  addEventListener('resize', layout);
  const clamp = (value, size) => Math.min(Math.max(Math.round(value), 0), size - 1);
  function point(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / (box.width || 1) * W, W),
      y: clamp((event.clientY - box.top) / (box.height || 1) * shapeRows, shapeRows),
    };
  }
  function send(event) {
    fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {});
  }
  const button = (pressed) => pressed === 0 ? 'left' : pressed === 1 ? 'middle' : 'right';
  // A moving pointer sends at most this often (the host's pointer takes it at its own rate).
  let movedAt = 0;
  addEventListener('pointermove', (event) => {
    const now = performance.now();
    if (now - movedAt < 8) return;
    movedAt = now;
    const p = point(event);
    send({ type: 'move', x: p.x, y: p.y });
  }, { passive: true });
  addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const p = point(event);
    send({ type: 'down', x: p.x, y: p.y, button: button(event.button) });
  }, { passive: false });
  const up = (event) => {
    event.preventDefault();
    const p = point(event);
    send({ type: 'up', x: p.x, y: p.y, button: button(event.button) });
  };
  addEventListener('pointerup', up, { passive: false });
  addEventListener('pointercancel', up, { passive: false });
  addEventListener('wheel', (event) => {
    event.preventDefault();
    const p = point(event);
    // Up the page negative, in the 120s a wheel notch is (the page's own sign; the host turns it for Win32).
    send({ type: 'wheel', x: p.x, y: p.y, delta: event.deltaY < 0 ? -120 : 120 });
  }, { passive: false });
  addEventListener('contextmenu', (event) => event.preventDefault());
  layout();
  pump();
})();
</script>
</body>
</html>
"##;

fn respond_html(request: Request) {
    let headers = vec![header("Content-Type", "text/html; charset=utf-8"), header("Cache-Control", "no-store")];
    let _ = request.respond(Response::new(StatusCode(200), headers, VIEWER.as_bytes(), Some(VIEWER.len()), None));
}

fn info(request: Request, context: &Context) {
    let (page_width, page_height, rows) = page_shape();
    let body = serde_json::json!({
        "port": context.port,
        "lan": context.lan,
        "quality": QUALITY.load(Ordering::Relaxed),
        "fps": FPS.load(Ordering::Relaxed),
        "width": FRAME_WIDTH,
        "height": FRAME_HEIGHT,
        "pageWidth": page_width,
        "pageHeight": page_height,
        "frameRows": rows,
    })
    .to_string();
    let headers = vec![header("Content-Type", "application/json"), header("Cache-Control", "no-store")];
    let _ = request.respond(Response::new(StatusCode(200), headers, body.as_bytes(), Some(body.len()), None));
}

/// The newest frame, waited for up to [`FRAME_WAIT`]: `200 image/jpeg` with `X-Seq` its number, or `204` when no
/// frame newer than `after` came. The `id` is how a viewer is told apart (the status's `clients`).
fn frame(request: Request, url: &str) {
    let after = query(url, "after").and_then(|after| after.parse().ok()).unwrap_or(0);
    let id = query(url, "id").filter(|id| !id.is_empty()).unwrap_or("anonymous").to_owned();
    {
        let mut clients = clients().lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        clients.retain(|_, asked| now.saturating_duration_since(*asked) <= CLIENT_KEEP);
        clients.insert(id, now);
    }
    let inbox = latest();
    let mut latest = inbox.lock();
    let deadline = Instant::now() + FRAME_WAIT;
    loop {
        if let Some((seq, jpeg)) = latest.as_ref()
            && *seq > after
        {
            let (seq, jpeg) = (*seq, Arc::clone(jpeg));
            drop(latest);
            let (page_width, page_height, rows) = page_shape();
            let headers = vec![
                header("Content-Type", "image/jpeg"),
                header("Cache-Control", "no-store"),
                header("X-Seq", &seq.to_string()),
                header("X-Page-Width", &page_width.to_string()),
                header("X-Page-Height", &page_height.to_string()),
                header("X-Frame-Rows", &rows.to_string()),
            ];
            let _ = request.respond(Response::new(StatusCode(200), headers, &jpeg[..], Some(jpeg.len()), None));
            return;
        }
        let now = Instant::now();
        let Some(left) = deadline.checked_duration_since(now) else {
            drop(latest);
            let _ = request.respond(Response::empty(StatusCode(204)));
            return;
        };
        latest = inbox.wait_timeout(latest, left);
    }
}

/// A mouse event of the viewer's (`POST /api/input`): checked, and queued for the host's loop.
fn post_input(mut request: Request) {
    let mut body = Vec::new();
    if request.as_reader().take(INPUT_BODY_MAX).read_to_end(&mut body).is_err() {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    }
    let Ok(input) = serde_json::from_slice::<InputEvent>(&body) else {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    };
    {
        let mut inputs = inputs().lock().unwrap_or_else(|e| e.into_inner());
        if inputs.len() >= INPUTS_MAX {
            inputs.pop_front();
        }
        inputs.push_back(input.clamped());
    }
    let _ = request.respond(Response::empty(StatusCode(204)));
}

/// A query's value (`/api/frame?after=12&id=abc`).
fn query<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then_some(value)
    })
}

/// This PC's address on the network, as it would reach the internet: a `connect` on a UDP socket sends nothing, it
/// only picks the route (and with it the address a phone on the same Wi-Fi would use). `None`: no route (offline,
/// or only on IPv6).
fn lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    address.is_ipv4().then_some(address)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a plain header")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_json_is_the_mouse_it_says() {
        let read = |json: &str| serde_json::from_str::<InputEvent>(json).unwrap().clamped();
        assert_eq!(read(r#"{"type":"move","x":640,"y":360}"#), InputEvent::Move { x: 640, y: 360 });
        assert_eq!(
            read(r#"{"type":"down","x":640,"y":360,"button":"left"}"#),
            InputEvent::Down { x: 640, y: 360, button: Button::Left }
        );
        assert_eq!(
            read(r#"{"type":"up","x":12,"y":34,"button":"right"}"#),
            InputEvent::Up { x: 12, y: 34, button: Button::Right }
        );
        assert_eq!(read(r#"{"type":"wheel","x":1,"y":2,"delta":-120}"#), InputEvent::Wheel { x: 1, y: 2, delta: -120 });
        // Off the frame: kept on it.
        assert_eq!(read(r#"{"type":"move","x":-5,"y":9000}"#), InputEvent::Move { x: 0, y: 719 });
        // Not a mouse event of the kinds the viewer sends.
        for bad in [r#"{"type":"hover","x":1,"y":2}"#, r#"{"type":"down","x":1,"y":2,"button":"thumb"}"#, "[]"] {
            assert!(serde_json::from_str::<InputEvent>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_viewer_page_pulls_frames_and_sends_the_mouse() {
        assert!(VIEWER.contains("/api/frame"), "the frames it shows");
        assert!(VIEWER.contains("/api/input"), "the mouse it sends");
        assert!(VIEWER.contains("<canvas id=\"frame\">"), "the picture drawn as it comes");
        assert!(VIEWER.contains("createImageBitmap"), "a frame decoded off the drawing");
        assert!(VIEWER.contains("cursor:none"), "no second cursor over the frame's own");
        assert!(VIEWER.contains("width=device-width"), "a phone's own width");
    }

    #[test]
    fn the_viewer_is_told_the_pages_own_shape() {
        assert!(VIEWER.contains("X-Page-Height"), "the page's height with each frame");
        assert!(VIEWER.contains("X-Frame-Rows"), "the rows it's carried in");
        set_page(1280, 793, 720);
        assert_eq!(page_shape(), (1280, 793, 720));
        set_page(0, 0, 0);
        assert_eq!(page_shape(), (1, 1, 1));
        set_page(FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEIGHT);
    }

    #[test]
    fn a_frame_request_says_which_frame_to_wait_after() {
        assert_eq!(query("/api/frame?after=12&id=abc", "after"), Some("12"));
        assert_eq!(query("/api/frame?after=12&id=abc", "id"), Some("abc"));
        assert_eq!(query("/api/frame?after=12", "id"), None);
        assert_eq!(query("/api/frame", "after"), None);
    }

    #[test]
    fn a_frame_is_a_jpeg_of_the_frame_size() {
        // Two by two, each row blue then white (BGRA).
        let mut bgra = Vec::new();
        for _ in 0..2 {
            bgra.extend_from_slice(&[255, 0, 0, 255]);
            bgra.extend_from_slice(&[255, 255, 255, 255]);
        }
        let mut rgb = Vec::new();
        let jpeg = jpeg(2, 2, &bgra, 85, &mut rgb).expect("a JPEG");
        assert_eq!((jpeg[0], jpeg[1]), (0xff, 0xd8), "a JPEG's start");
        assert_eq!(rgb.len(), 2 * 2 * 3, "the frame's pixels as RGB");
        assert_eq!((rgb[0], rgb[1], rgb[2]), (0, 0, 255), "BGRA blue to RGB");
    }
}
