//! The cabin page mirrored on a local port: the same page, for the player's phone or tablet beside the truck's
//! screen.
//!
//! The cabin page is drawn offscreen and copied into the game's screen texture: there is no window of it to open
//! elsewhere. So this serves its files itself (or passes them on from the dev server), sends the same messages the
//! cabin page gets (`GET /api/events`, `text/event-stream`), and takes what the mirrored page posts back
//! (`POST /api/page`) as if the cabin page had posted it ([`crate::webview::OffscreenWebView`]).
//!
//! It listens on 127.0.0.1, or on every adapter when the player turns the LAN on: then, on the same Wi-Fi, a phone
//! shows the page too. Only the page's own files are served: a path that tries to leave its folder, or a file that
//! isn't the page's (an extension [`EXTENSIONS`] doesn't have), is never read.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::net::{IpAddr, UdpSocket};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::settings::MirrorSettings;

/// The messages queued for one mirrored page: a page that falls this far behind (its connection stuck) is let go
/// rather than holding the host's messages (`broadcast`).
const CLIENT_QUEUE: usize = 512;

/// How often a quiet SSE connection is told it's still there, so a connection gone (or a proxy between) is found.
const PING_EVERY: Duration = Duration::from_secs(15);

/// The most of a `POST /api/page` body read: a PageMessage is a few KB at most.
const PAGE_BODY_MAX: u64 = 256 * 1024;

/// The most PageMessages waiting for the host: the oldest go if the host falls behind (a page sends its state
/// anew as it loads, and a message is one change of the page's).
const PAGE_MESSAGES_MAX: usize = 256;

/// The files the page may ask for, by extension: its page and scripts, its styles and data, its images and fonts,
/// the map's tiles, and the player's own wallpapers and icon sets (`customize`'s kinds, BMP wallpapers among them).
/// Nothing else is ever read.
const EXTENSIONS: [&str; 18] = [
    "html", "js", "css", "json", "svg", "png", "jpg", "jpeg", "webp", "gif", "bmp", "woff", "woff2", "ttf", "pbf",
    "bin", "txt", "map",
];

/// What the mirrored page is served from: the page's folder (a built UI, as the cabin's WebView serves it), or the
/// dev server (a UI being developed), and the host's data folder (the maps, wallpapers and music covers, which the
/// WebView maps to their own hosts and this serves under `/maps`, `/customize` and `/music-covers`).
pub struct Sources {
    pub page_root: Option<PathBuf>,
    pub dev_url: Option<String>,
    pub data_dir: PathBuf,
}

/// A running mirror, until dropped (or [`Mirror::stop`]): its listener, the thread taking requests, and where the
/// page can be reached. Dropping it stops the listener.
pub struct Mirror {
    server: Arc<Server>,
    accept: Mutex<Option<thread::JoinHandle<()>>>,
    pub port: u16,
    pub lan: bool,
    /// The page, as a browser on this PC opens it.
    pub local_url: String,
    /// The same at this PC's address on the network (`None`: the LAN is off, or the PC has no address to find).
    pub lan_url: Option<String>,
    /// `None` while it runs (nothing sets it yet): a start that failed has no `Mirror`, and its reason is the
    /// status's error instead (`MirrorStatus::error`, made by `lib`'s `mirror_status`). Kept for a listener that
    /// stops after starting.
    pub error: Option<String>,
}

/// What a request is answered from: the settings it was started with, and the files it serves.
struct Context {
    port: u16,
    lan: bool,
    page_root: Option<PathBuf>,
    dev_url: Option<String>,
    data_dir: PathBuf,
}

/// One SSE connection: its id (to drop just it when it ends) and the host's messages queued for it.
struct Client {
    id: u64,
    messages: SyncSender<String>,
}

/// An SSE connection's body: the messages the host sends, a ping every so often, and first `: connected`. It
/// blocks in `read` for its messages, which is what keeps the response open.
struct Events {
    messages: Receiver<String>,
    /// The bytes of one event not handed over yet, and how many of them are.
    pending: Vec<u8>,
    sent: usize,
    connected: bool,
    done: bool,
}

/// The SSE connections of the running mirror. `broadcast` sends the host's messages to all of them; one whose
/// queue is full or gone is dropped. Empty while no mirror runs, so every call is safe then.
static CLIENTS: OnceLock<Mutex<Vec<Client>>> = OnceLock::new();

/// The PageMessages the mirrored pages posted, for the host to take ([`take_page_messages`]).
static PAGE_MESSAGES: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

/// The id of the next SSE connection.
static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

/// Starts serving the page on `settings`'s port, on 127.0.0.1 or (the LAN on) on every adapter. The caller stops
/// the previous mirror first: it may hold the same port.
pub fn start(settings: &MirrorSettings, sources: &Sources) -> Result<Mirror, String> {
    let address = if settings.lan {
        format!("0.0.0.0:{}", settings.port)
    } else {
        format!("127.0.0.1:{}", settings.port)
    };
    let server = Server::http(address.as_str()).map_err(|error| format!("can't listen on {address}: {error}"))?;
    let server = Arc::new(server);
    let context = Arc::new(Context {
        port: settings.port,
        lan: settings.lan,
        page_root: sources.page_root.clone(),
        dev_url: sources.dev_url.clone(),
        data_dir: sources.data_dir.clone(),
    });
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
    /// How many mirrored pages are listening for the host's messages now.
    pub fn clients(&self) -> usize {
        client_count()
    }

    /// Stops the listener: `unblock` is how tiny_http ends an `incoming_requests` loop from another thread, and
    /// the accept thread joins after it. The pages' connections are let go too.
    pub fn stop(&self) {
        self.server.unblock();
        close_clients();
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

/// Sends one of the host's messages to every mirrored page, as `data: <json>`. Nothing goes anywhere while no
/// page is connected, so it's safe to call whether a mirror runs or not.
pub fn broadcast(json: &str) {
    let mut clients = client_list().lock().unwrap_or_else(|e| e.into_inner());
    // A connection whose queue is full (its page isn't reading) or gone is dropped: nothing more is sent to it.
    clients.retain_mut(|client| client.messages.try_send(json.to_owned()).is_ok());
}

/// The PageMessages the mirrored pages posted since the last call, oldest first.
pub fn take_page_messages() -> Vec<String> {
    let Some(messages) = PAGE_MESSAGES.get() else { return Vec::new() };
    let mut messages = messages.lock().unwrap_or_else(|e| e.into_inner());
    messages.drain(..).collect()
}

/// The list of SSE connections, made on first use (or before: no mirror yet).
fn client_list() -> &'static Mutex<Vec<Client>> {
    CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn client_count() -> usize {
    CLIENTS.get().map_or(0, |clients| clients.lock().unwrap_or_else(|e| e.into_inner()).len())
}

/// Registers a new SSE connection, then tells the host a page has just connected (a `ready` PageMessage, as the
/// cabin page posts when it loads): the host sends the current state again, and this connection is in the list
/// before that message is even queued, so none of the state sent again is missed.
fn subscribe() -> (u64, Receiver<String>) {
    let id = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
    let (messages, receiver) = mpsc::sync_channel(CLIENT_QUEUE);
    {
        let mut clients = client_list().lock().unwrap_or_else(|e| e.into_inner());
        clients.push(Client { id, messages });
    }
    push_page_message(r#"{"type":"ready"}"#.to_owned());
    (id, receiver)
}

fn unsubscribe(id: u64) {
    client_list().lock().unwrap_or_else(|e| e.into_inner()).retain(|client| client.id != id);
}

/// Lets every page's connection go (its `read` sees the channel gone and ends the response).
fn close_clients() {
    if let Some(clients) = CLIENTS.get() {
        clients.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

fn push_page_message(json: String) {
    let messages = PAGE_MESSAGES.get_or_init(|| Mutex::new(VecDeque::new()));
    let mut messages = messages.lock().unwrap_or_else(|e| e.into_inner());
    if messages.len() >= PAGE_MESSAGES_MAX {
        messages.pop_front();
    }
    messages.push_back(json);
}

fn serve(request: Request, context: &Context) {
    let url = request.url().to_owned();
    let path = url.split('?').next().unwrap_or_default();
    if request.method() == &Method::Post {
        if path == "/api/page" {
            post_page(request);
        } else {
            let _ = request.respond(Response::empty(StatusCode(405)));
        }
        return;
    }
    if request.method() != &Method::Get {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }
    match path {
        "/" => redirect(request),
        "/cabin.html" => cabin(request, context),
        "/api/events" => events(request),
        "/api/info" => info(request, context),
        _ => {
            if let Some((folder, rest)) = mapped(path, context) {
                serve_file(request, &folder, rest);
            } else if context.dev_url.is_some() {
                proxy(request, context, &url);
            } else if let Some(root) = &context.page_root {
                serve_file(request, root, path);
            } else {
                let _ = request.respond(Response::empty(StatusCode(404)));
            }
        }
    }
}

fn redirect(request: Request) {
    let mut response = Response::empty(StatusCode(302));
    response.add_header(header("Location", "/cabin.html"));
    let _ = request.respond(response);
}

/// The page itself, with the mirror's script injected: from the dev server when there is one (a UI being
/// developed), otherwise the page's folder.
fn cabin(request: Request, context: &Context) {
    if let Some(dev_url) = &context.dev_url {
        let Some(target) = dev_target(dev_url, request.url()) else {
            let _ = request.respond(Response::empty(StatusCode(502)));
            return;
        };
        let Some(response) = fetch(&target) else {
            let _ = request.respond(Response::empty(StatusCode(502)));
            return;
        };
        let status = StatusCode(response.status().as_u16());
        let Ok(html) = response.text() else {
            let _ = request.respond(Response::empty(StatusCode(502)));
            return;
        };
        respond_html(request, status, with_mirror(&html, context.port));
        return;
    }
    let Some(root) = &context.page_root else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Ok(html) = std::fs::read_to_string(root.join("cabin.html")) else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    respond_html(request, StatusCode(200), with_mirror(&html, context.port));
}

fn events(request: Request) {
    let (id, messages) = subscribe();
    let headers = vec![header("Content-Type", "text/event-stream"), header("Cache-Control", "no-cache")];
    let body = Events { messages, pending: Vec::new(), sent: 0, connected: false, done: false };
    // No length: the response is chunked, each event sent as it comes.
    let _ = request.respond(Response::new(StatusCode(200), headers, body, None, None));
    unsubscribe(id);
}

fn post_page(mut request: Request) {
    let mut body = Vec::new();
    if request.as_reader().take(PAGE_BODY_MAX).read_to_end(&mut body).is_err() {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    }
    let Ok(body) = String::from_utf8(body) else {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    };
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    }
    push_page_message(body);
    let _ = request.respond(Response::empty(StatusCode(204)));
}

fn info(request: Request, context: &Context) {
    let body = serde_json::json!({ "port": context.port, "lan": context.lan }).to_string();
    let length = body.len();
    let headers = vec![header("Content-Type", "application/json"), header("Cache-Control", "no-store")];
    let body = io::Cursor::new(body.into_bytes());
    let _ = request.respond(Response::new(StatusCode(200), headers, body, Some(length), None));
}

/// A file the page asks for from its folder (folder mode), or a file of the host's data folders.
fn serve_file(request: Request, root: &Path, path: &str) {
    let Some(file) = file_in(root, path) else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Ok(data) = std::fs::read(&file) else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let length = data.len();
    let headers = vec![header("Content-Type", content_type(&file)), header("Cache-Control", "no-store")];
    let data = io::Cursor::new(data);
    let _ = request.respond(Response::new(StatusCode(200), headers, data, Some(length), None));
}

/// Whatever the dev server answers for the path and its query, passed on as it came (its `Content-Type` kept:
/// scripts, styles, images), so the page in the mirror is the one being developed.
fn proxy(request: Request, context: &Context, url: &str) {
    let Some(dev_url) = &context.dev_url else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Some(target) = dev_target(dev_url, url) else {
        let _ = request.respond(Response::empty(StatusCode(502)));
        return;
    };
    let Some(response) = fetch(&target) else {
        let _ = request.respond(Response::empty(StatusCode(502)));
        return;
    };
    let status = StatusCode(response.status().as_u16());
    let mut headers = vec![header("Cache-Control", "no-store")];
    if let Some(kind) = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()) {
        headers.push(header("Content-Type", kind));
    }
    let length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let response = Response::new(status, headers, response, length, None);
    let _ = request.respond(response);
}

impl Read for Events {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.done || buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.sent < self.pending.len() {
                let left = &self.pending[self.sent..];
                let count = left.len().min(buffer.len());
                buffer[..count].copy_from_slice(&left[..count]);
                self.sent += count;
                if self.sent == self.pending.len() {
                    self.pending.clear();
                    self.sent = 0;
                }
                return Ok(count);
            }
            self.pending.clear();
            self.sent = 0;
            if !self.connected {
                self.connected = true;
                self.pending = b": connected\n\n".to_vec();
                continue;
            }
            match self.messages.recv_timeout(PING_EVERY) {
                Ok(json) => self.pending = format!("data: {json}\n\n").into_bytes(),
                Err(RecvTimeoutError::Timeout) => self.pending = b": ping\n\n".to_vec(),
                Err(RecvTimeoutError::Disconnected) => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
    }
}

/// The folder a request under `/maps/`, `/customize/` or `/music-covers/` is served from (the same files the
/// cabin page's WebView maps to their own hosts), and the rest of its path in it.
fn mapped<'a>(path: &'a str, context: &Context) -> Option<(PathBuf, &'a str)> {
    if let Some(rest) = path.strip_prefix("/maps/") {
        Some((context.data_dir.join("maps"), rest))
    } else if let Some(rest) = path.strip_prefix("/customize/") {
        Some((context.data_dir.join(crate::customize::FOLDER), rest))
    } else if let Some(rest) = path.strip_prefix("/music-covers/") {
        Some((context.data_dir.join("music-covers"), rest))
    } else {
        None
    }
}

/// A file of `root` for a request's path (`/assets/app.js`): `None` for a path that tries to leave the folder (a
/// `..`, an absolute one, a Windows drive or stream), or a file of a kind the page doesn't have.
///
/// The browser sends the path percent-encoded (the player's own wallpaper `Dusk (2).dark.jpg` comes as
/// `Dusk%20(2).dark.jpg`): each segment is decoded first, and checked as it means, so an encoded `..` (`%2e%2e`)
/// or an encoded `/` (`%2f`) is no way out either.
fn file_in(root: &Path, path: &str) -> Option<PathBuf> {
    let mut file = root.to_path_buf();
    for segment in path.trim_start_matches('/').split('/') {
        let decoded = percent_encoding::percent_decode_str(segment).decode_utf8().ok()?;
        // Stated, so `push` needn't choose which of `&str`'s `AsRef`s the decoded segment is.
        let segment: &str = decoded.as_ref();
        let outside = segment.is_empty()
            || segment == "."
            || segment == ".."
            || Path::new(segment).is_absolute()
            || Path::new(segment).has_root()
            || segment.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0') || c.is_control());
        if outside {
            return None;
        }
        file.push(segment);
    }
    let extension = file.extension()?.to_str()?.to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    // The file as Windows resolves it, to know it's a file of the folder and not a link out of it.
    let root = root.canonicalize().ok()?;
    let file = file.canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

fn content_type(file: &Path) -> &'static str {
    let extension = file.extension().and_then(|extension| extension.to_str()).unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "pbf" => "application/x-protobuf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The page with the mirror's own script before its `</head>` (at its start without one): the page there knows
/// it's mirrored, and on which port its messages go (`window.__WESTPLAY_MIRROR__`).
fn with_mirror(html: &str, port: u16) -> String {
    let script = format!("<script>window.__WESTPLAY_MIRROR__={{\"port\":{port}}}</script>");
    let at = html.find("</head>").unwrap_or(0);
    let mut injected = String::with_capacity(html.len() + script.len());
    injected.push_str(&html[..at]);
    injected.push_str(&script);
    injected.push_str(&html[at..]);
    injected
}

/// The dev server's URL for a request's path and query (`/cabin.html?v=1`): on the origin `dev_url` names (it
/// may point at a page).
fn dev_target(dev_url: &str, url: &str) -> Option<String> {
    let (scheme, rest) = dev_url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    Some(format!("{scheme}://{authority}{url}"))
}

/// One GET to the dev server. Straight out, never through the machine's own proxy: one (a VPN's, a capture tool's)
/// may answer local addresses itself, with something that isn't the page.
fn fetch(url: &str) -> Option<reqwest::blocking::Response> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?
        .get(url)
        .send()
        .ok()
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

fn respond_html(request: Request, status: StatusCode, html: String) {
    let length = html.len();
    let headers = vec![header("Content-Type", "text/html; charset=utf-8"), header("Cache-Control", "no-store")];
    let html = io::Cursor::new(html.into_bytes());
    let _ = request.respond(Response::new(status, headers, html, Some(length), None));
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a plain header")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_pages_files_by_their_percent_encoded_names() {
        let dir = std::env::temp_dir().join(format!("westplay-mirror-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Dusk (2).dark.jpg"), "jpeg").unwrap();
        std::fs::write(dir.join("夜色.jpg"), "jpeg").unwrap();
        // As the page encodes them (`customize.ts`'s `fileUrl`): the spaces, brackets and characters.
        assert!(file_in(&dir, "/Dusk%20(2).dark.jpg").unwrap().ends_with("Dusk (2).dark.jpg"));
        assert!(file_in(&dir, "/%E5%A4%9C%E8%89%B2.jpg").unwrap().ends_with("夜色.jpg"));
        // No way out, encoded or not.
        let outside = ["/../settings.json", "/%2e%2e/settings.json", "/..%5csettings.json", "/%2e%2e%2fsettings.json"];
        for path in outside {
            assert_eq!(file_in(&dir, path), None, "{path}");
        }
        assert_eq!(file_in(&dir, "/Dusk%20(2).dark.jpg%00"), None);
        // A kind the page doesn't have ([`EXTENSIONS`] leaves it out), and one that isn't there.
        std::fs::write(dir.join("movie.mp4"), "video").unwrap();
        assert_eq!(file_in(&dir, "/movie.mp4"), None);
        assert_eq!(file_in(&dir, "/missing.jpg"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
