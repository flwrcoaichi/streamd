import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import tornado.ioloop
import tornado.web

from config import (
    log, BASE_DIR, OVERLAY_DIR, OVERLAY_SEARCH_DIRS, PNGTUBER_DIR, PNGTUBER_STATES,
    MEDIA_DIR, MEDIA_EXTS, MV_CACHE_DIR, HTTP_PORT, LAYOUTS_DIR,
    TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
    CANVAS_PUBLIC_PORT, CANVAS_PUBLIC_BASE_URL, CANVAS_PUBLIC_COOKIE,
    CANVAS_PUBLIC_REDIRECT_PATH, CANVAS_PUBLIC_TWITCH_SCOPE,
)
from canvas import place_public_pixel
from state import state

_REDEEM_PLAYER_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>redeem player</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; width: 100vw; height: 100vh; }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  video, audio { max-width: 100vw; max-height: 100vh; display: none; }
  video.active { display: block; }
</style>
</head>
<body>
<div id="stage">
  <video id="player" playsinline></video>
  <audio id="mainAudio"></audio>
  <audio id="scoreAudio"></audio>
</div>
<script>
// tangia-like redeem player — connects to the same control websocket as the
// rest of the overlays and plays whatever file a "play_media" broadcast
// points at. add this as a Browser Source in OBS (transparent bg), sized
// to your scene. files live in the /media/ directory next to the script
// (STREAM_MEDIA_DIR / redeems/media by default).
//
// a redeem can specify:
//   file  — a video (mp4/webm/mov) or audio (mp3/wav/ogg) file, required
//   audio — an optional second audio file to play AT THE SAME TIME as
//           `file` (e.g. score a silent/muted clip with a specific song,
//           or layer music under a video that already has its own sound)
const WS_URL = "ws://localhost:8877";
const video      = document.getElementById("player");
const mainAudio  = document.getElementById("mainAudio");   // plays `file` when it's audio-only
const scoreAudio = document.getElementById("scoreAudio");  // plays the optional `audio` companion track

// OBS's embedded Chromium enforces the same autoplay-with-sound rules as a
// regular browser: unmuted play() can get silently rejected until the page
// has "user activation". we try unmuted first (so a video's own audio
// track and any companion track actually play), and only fall back to
// muted playback if the browser blocks it — better a silent clip than a
// stuck queue.
let queue = [];
let playing = false;
let watchdogs = [];

function isVideoFile(name) {
  return /\\.(mp4|webm|mov)$/i.test(name);
}

function clearWatchdogs() {
  for (const w of watchdogs) clearTimeout(w);
  watchdogs = [];
}

function armWatchdog(el, onDone) {
  // belt-and-suspenders: if 'ended'/'error' never fire for some reason
  // (codec quirk, OBS source getting hidden/shown, etc), this guarantees
  // the queue un-sticks itself instead of dying after one play forever.
  const guessMs = (isFinite(el.duration) && el.duration > 0)
    ? (el.duration * 1000) + 3000
    : 60000;
  watchdogs.push(setTimeout(onDone, guessMs));
}

// plays `el` with `url`, trying unmuted first and falling back to muted
// autoplay if the browser rejects it. resolves once playback has actually
// started (or been given up on).
function playEl(el, url) {
  return new Promise((resolve) => {
    el.muted = false;
    el.src = url;
    el.currentTime = 0;
    el.play().then(resolve).catch(() => {
      console.warn("unmuted play blocked, retrying muted:", url);
      el.muted = true;
      el.play().then(resolve).catch((err) => {
        console.error("play failed even muted, skipping:", url, err);
        resolve();
      });
    });
  });
}

// tracks how many of the (up to 2) concurrently-playing elements for the
// current queue item are still going, so we only advance the queue once
// everything for this item has actually finished — e.g. a companion song
// longer than its video won't get cut off early.
let activeCount = 0;

function trackElement(el) {
  activeCount++;
  const done = () => {
    el.removeEventListener("ended", done);
    el.removeEventListener("error", done);
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) finishItem();
  };
  el.addEventListener("ended", done);
  el.addEventListener("error", done);
  armWatchdog(el, done);
}

function playNext() {
  if (playing || queue.length === 0) return;
  playing = true;
  activeCount = 0;
  clearWatchdogs();
  const item = queue.shift();
  const mainUrl = "/media/" + encodeURIComponent(item.file);
  const mainIsVideo = isVideoFile(item.file);

  const mainEl = mainIsVideo ? video : mainAudio;
  if (mainIsVideo) {
    mainAudio.pause();
    video.classList.add("active");
  } else {
    video.pause();
    video.classList.remove("active");
  }

  playEl(mainEl, mainUrl).then(() => trackElement(mainEl));

  if (item.audio) {
    const scoreUrl = "/media/" + encodeURIComponent(item.audio);
    playEl(scoreAudio, scoreUrl).then(() => trackElement(scoreAudio));
  }
}

function finishItem() {
  clearWatchdogs();
  video.classList.remove("active");
  video.pause();
  mainAudio.pause();
  scoreAudio.pause();
  video.removeAttribute("src");
  mainAudio.removeAttribute("src");
  scoreAudio.removeAttribute("src");
  video.load();
  mainAudio.load();
  scoreAudio.load();
  playing = false;
  playNext();
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === "play_media" && msg.file) {
      queue.push(msg);
      playNext();
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}
connect();
</script>
</body>
</html>
"""


def _ensure_redeem_player_html() -> None:
    """writes redeem-player.html into the primary overlay dir, so
    /redeem-player works out of the box as an OBS browser source without
    you having to hand-author it. always overwrites — if you've customized
    the file yourself, rename it (e.g. redeem-player.custom.html) and point
    OBS at that instead, otherwise your edits get clobbered on every
    restart."""
    try:
        target_dir = OVERLAY_SEARCH_DIRS[0] if OVERLAY_SEARCH_DIRS else OVERLAY_DIR
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / "redeem-player.html"
        if not path.exists():
            path.write_text(_REDEEM_PLAYER_HTML, encoding="utf-8")
            log.info("[redeems] wrote redeem-player.html to %s", path)
    except Exception as e:
        log.warning("[redeems] could not write redeem-player.html: %s", e)


def _resolve_overlay_file(filename: str) -> pathlib.Path | None:
    """searches OVERLAY_SEARCH_DIRS in priority order (repo-local `./overlay`
    first unless STREAM_OVERLAY_DIR is explicitly set, then the legacy
    C:\\Stream\\overlays) and returns the first match. this lets vanillyn
    edit files in the repo's overlay/ folder directly without needing to
    copy them into C:\\Stream."""
    for directory in OVERLAY_SEARCH_DIRS:
        try:
            candidate = directory / filename
            if candidate.exists():
                return candidate
        except Exception:
            continue
    return None


class OverlayHandler(tornado.web.RequestHandler):
    """serves an overlay html file, searching across OVERLAY_SEARCH_DIRS.
    `directory`, if given, is tried first (kept for handlers that used to
    pin a specific folder), then the standard search list."""

    def initialize(self, filename: str, directory: pathlib.Path | None = None) -> None:
        self.filename = filename
        self.directory = directory

    def get(self) -> None:
        if self.directory is not None:
            pinned = self.directory / self.filename
            if pinned.exists():
                self.set_header("Content-Type", "text/html; charset=utf-8")
                self.write(pinned.read_text(encoding="utf-8"))
                return
        path = _resolve_overlay_file(self.filename)
        if path is not None:
            self.set_header("Content-Type", "text/html; charset=utf-8")
            self.write(path.read_text(encoding="utf-8"))
        else:
            self.set_status(404)
            self.write(f"not found: {self.filename} (searched {[str(d) for d in OVERLAY_SEARCH_DIRS]})")


class OverlayStaticHandler(tornado.web.RequestHandler):
    """catch-all static file server for overlay assets, searching across
    OVERLAY_SEARCH_DIRS instead of a single fixed directory."""

    def get(self, path: str) -> None:
        if not path or ".." in path:
            self.set_status(404)
            return
        resolved = _resolve_overlay_file(path)
        if resolved is None:
            self.set_status(404)
            return
        content_type = "application/octet-stream"
        suffix = resolved.suffix.lower()
        if suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif suffix == ".css":
            content_type = "text/css"
        elif suffix == ".js":
            content_type = "application/javascript"
        elif suffix == ".json":
            content_type = "application/json"
        elif suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
            content_type = f"image/{suffix.lstrip('.')}"
        self.set_header("Content-Type", content_type)
        try:
            self.write(resolved.read_bytes())
        except Exception:
            self.set_status(404)


class WOSLoginHandler(tornado.web.RequestHandler):
    """top-level sign-in helper for WOS: OBS Browser Source cannot complete
    NextAuth flows because the browser rejects the required cookies in a
    cross-site iframe. this page tells the user to open it in a normal
    browser tab, where the auth cookies can be stored correctly."""

    def get(self) -> None:
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.write("""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WOS login</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0a0c0d; color: #e8edf1; font-family: ui-monospace, monospace;
    }
    .card {
      width: min(620px, calc(100vw - 32px)); padding: 28px; border: 1px solid #d7c385; border-radius: 12px;
      background: rgba(20,24,28,0.96); box-shadow: 0 8px 30px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 12px; font-size: 1.4rem; }
    p { line-height: 1.7; color: #cfdae2; }
    .btn {
      display: inline-block; margin-top: 10px; padding: 10px 16px; border-radius: 8px;
      background: #d7c385; color: #0a0c0d; text-decoration: none; font-weight: 700;
    }
    .warn { color: #ffcf70; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Words on Stream login</h1>
    <p>
      Open this in a regular browser tab, not inside OBS. WOS uses NextAuth cookies,
      and OBS Browser Source blocks them when the site is embedded in an iframe.
    </p>
    <p class="warn">
      Sign in here once, then reload the OBS Browser Source for the WOS panel.
      The session will stay in the browser profile that completed the login.
    </p>
    <a class="btn" href="https://wos.gg/api/auth/signin/twitch" target="_blank" rel="noopener noreferrer">
      open WOS sign-in in browser
    </a>
    <p>
      If the page is already open in a browser, you can also go directly to
      <a href="https://wos.gg/" target="_blank" rel="noopener noreferrer">https://wos.gg/</a>
      and log in there.
    </p>
  </div>
</body>
</html>""")


class PngtuberAssetsHandler(tornado.web.RequestHandler):
    """lists available images per pngtuber state, so the overlay/control
    page can pick one (randomly, for idle variety) without needing a
    directory listing endpoint from the static file handler."""

    def get(self) -> None:
        out = {}
        for pstate in PNGTUBER_STATES:
            d = PNGTUBER_DIR / pstate
            imgs = sorted(
                f"/pngtuber-assets/{pstate}/{p.name}"
                for p in d.iterdir()
                if p.suffix.lower() in (".png", ".webp", ".gif")
            ) if d.exists() else []
            out[pstate] = imgs
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps(out))


class MediaListHandler(tornado.web.RequestHandler):
    """lists files in MEDIA_DIR, so the control panel can offer a dropdown
    of filenames when configuring a play_media reward."""

    def get(self) -> None:
        files = sorted(
            p.name for p in MEDIA_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in MEDIA_EXTS
        ) if MEDIA_DIR.exists() else []
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"files": files}))


class TTSVoicesHandler(tornado.web.RequestHandler):
    """lists voice names available in TTS_VOICES_DIR, for the control
    panel's reward editor (voice dropdown on the tts action)."""

    def get(self) -> None:
        from tts import _tts_list_voices
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"voices": sorted(_tts_list_voices().keys())}))


class CommandsHandler(tornado.web.RequestHandler):
    """read-only JSON snapshot of live state, for the control panel to
    bootstrap from on load (it also gets live updates over the websocket)."""

    def get(self) -> None:
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps(state.data))


class CanvasPublicPageHandler(tornado.web.RequestHandler):
    """public Twitch-authenticated canvas page on the dedicated public port."""

    def get(self) -> None:
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.write("""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Canvas Sign-in</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(circle at top, #1b2430, #090b0d 55%);
      font-family: Inter, system-ui, sans-serif; color: #edf3ff;
    }
    .panel {
      width: min(980px, calc(100vw - 24px));
      background: rgba(11, 15, 18, 0.96); border: 1px solid rgba(140, 169, 255, 0.55);
      border-radius: 18px; box-shadow: 0 20px 50px rgba(0,0,0,.35);
      padding: 20px;
    }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
    .meta { font-size: 0.85rem; color: #9bb0c8; }
    .status {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px;
      border-radius: 999px; background: rgba(142, 164, 255, 0.12); border: 1px solid rgba(142,164,255,.25);
      font-weight: 700;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #7ef2b4; }
    .dot.offline { background: #f7bf74; }
    .center { display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
    .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    button {
      border: 0; border-radius: 10px; padding: 10px 14px; font-weight: 700; cursor: pointer;
      background: #7ba5ff; color: #091320; box-shadow: 0 6px 18px rgba(95, 140, 255, 0.35);
    }
    button.secondary { background: #2b3540; color: #edf3ff; box-shadow: none; }
    input[type='color'] { width: 44px; height: 38px; padding: 0; border: 0; border-radius: 8px; background: transparent; }
    #board-wrap { overflow: auto; margin-top: 16px; border-radius: 12px; border: 1px solid rgba(146,173,255,.2); background: #0e1217; }
    canvas { display: block; background: #11161d; image-rendering: pixelated; }
    .note { color: #a7b9d1; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="topbar">
      <div>
        <div class="meta">Public canvas</div>
        <h1 style="margin:6px 0 0; font-size:1.5rem;">Place a pixel on the stream canvas</h1>
      </div>
      <div id="authStatus" class="status"><span class="dot offline"></span><span>Checking login…</span></div>
    </div>
    <div class="center">
      <div class="controls">
        <label for="colorPicker" style="font-weight:700;">Color</label>
        <input id="colorPicker" type="color" value="#ff7a18" aria-label="pixel color">
        <button id="loginBtn" type="button">Sign in with Twitch</button>
        <button id="refreshBtn" type="button" class="secondary">Refresh board</button>
      </div>
      <div id="whoami" class="meta">Not signed in</div>
    </div>
    <div id="board-wrap">
      <canvas id="canvas" width="800" height="800"></canvas>
    </div>
    <div class="note">One pixel per click. The board records your Twitch username so it can be matched to the shared canvas history.</div>
  </div>

  <script>
    const state = { size: 100, pixels: {}, owners: {} };
    const cellSize = 8;
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const colorPicker = document.getElementById('colorPicker');
    const loginBtn = document.getElementById('loginBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const authStatus = document.getElementById('authStatus');
    const whoami = document.getElementById('whoami');
    let username = null;

    function setStatus(online, text) {
      authStatus.innerHTML = `<span class="dot ${online ? '' : 'offline'}"></span><span>${text}</span>`;
    }

    async function jsonFetch(url, options = {}) {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'request failed');
      return data;
    }

    function drawBoard() {
      const size = state.size || 100;
      canvas.width = size * cellSize;
      canvas.height = size * cellSize;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const key = `${x},${y}`;
          ctx.fillStyle = state.pixels[key] || '#11161d';
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= size; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cellSize, 0);
        ctx.lineTo(i * cellSize, size * cellSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * cellSize);
        ctx.lineTo(size * cellSize, i * cellSize);
        ctx.stroke();
      }
    }

    async function loadSession() {
      try {
        const data = await jsonFetch('/canvas/session');
        username = data.username || null;
        if (username) {
          whoami.textContent = `Signed in as ${username}`;
          setStatus(true, 'Authenticated');
          loginBtn.textContent = 'Sign out';
        } else {
          whoami.textContent = 'Not signed in';
          setStatus(false, 'Not authenticated');
          loginBtn.textContent = 'Sign in with Twitch';
        }
      } catch (err) {
        whoami.textContent = 'Not signed in';
        setStatus(false, 'Not authenticated');
        username = null;
      }
    }

    async function loadBoard() {
      const data = await jsonFetch('/canvas/state');
      state.size = data.size || 100;
      state.pixels = data.pixels || {};
      state.owners = data.owners || {};
      drawBoard();
    }

    async function placePixel(x, y) {
      if (!username) {
        alert('Please sign in with Twitch before placing a pixel.');
        return;
      }
      const color = colorPicker.value;
      const response = await fetch('/canvas/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, color })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || 'place failed');
      }
      await loadBoard();
      if (data.message) {
        setStatus(true, data.message);
      }
    }

    canvas.addEventListener('click', async (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((event.clientX - rect.left) / (rect.width / state.size));
      const y = Math.floor((event.clientY - rect.top) / (rect.height / state.size));
      if (x < 0 || y < 0 || x >= state.size || y >= state.size) return;
      try {
        await placePixel(x, y);
      } catch (err) {
        alert(err.message || 'Failed to place pixel.');
      }
    });

    loginBtn.addEventListener('click', () => {
      if (username) {
        document.cookie = 'streamd_canvas_session=; Max-Age=0; path=/; SameSite=Lax';
        window.location.reload();
        return;
      }
      window.location.href = '/canvas/login';
    });

    refreshBtn.addEventListener('click', async () => {
      await loadSession();
      await loadBoard();
    });

    loadSession().then(loadBoard).catch(() => loadBoard());
  </script>
</body>
</html>""")


class CanvasPublicLoginHandler(tornado.web.RequestHandler):
    """redirects viewers to the Twitch OAuth page for public canvases."""

    def get(self) -> None:
        if not TWITCH_CLIENT_ID:
            self.set_status(503)
            self.write(json.dumps({"error": "TWITCH_CLIENT_ID is not configured for public canvas auth"}))
            return
        redirect_uri = f"{CANVAS_PUBLIC_BASE_URL}{CANVAS_PUBLIC_REDIRECT_PATH}"
        auth_url = (
            "https://id.twitch.tv/oauth2/authorize"
            f"?client_id={urllib.parse.quote(TWITCH_CLIENT_ID)}"
            f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
            "&response_type=code"
            f"&scope={urllib.parse.quote(CANVAS_PUBLIC_TWITCH_SCOPE)}"
        )
        self.redirect(auth_url)


class CanvasPublicCallbackHandler(tornado.web.RequestHandler):
    """completes Twitch OAuth and stores a session for the public draw page."""

    def get(self) -> None:
        params = urllib.parse.parse_qs(self.request.query)
        code = params.get("code", [""])[0].strip()
        if not code:
            self.set_status(400)
            self.write("<h1>Authorization failed</h1><p>No Twitch auth code was returned.</p>")
            return
        if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            self.set_status(503)
            self.write("<h1>Config error</h1><p>TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set.</p>")
            return
        try:
            redirect_uri = f"{CANVAS_PUBLIC_BASE_URL}{CANVAS_PUBLIC_REDIRECT_PATH}"
            payload = urllib.parse.urlencode({
                "client_id": TWITCH_CLIENT_ID,
                "client_secret": TWITCH_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            }).encode("utf-8")
            req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=payload, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                token_data = json.loads(resp.read().decode("utf-8"))
            access_token = token_data.get("access_token")
            if not access_token:
                raise RuntimeError("missing access_token in twitch oauth response")

            headers = {
                "Authorization": f"Bearer {access_token}",
                "Client-Id": TWITCH_CLIENT_ID,
            }
            user_req = urllib.request.Request("https://api.twitch.tv/helix/users", headers=headers, method="GET")
            with urllib.request.urlopen(user_req, timeout=10) as resp:
                user_data = json.loads(resp.read().decode("utf-8"))
            login = (user_data.get("data") or [{}])[0].get("login")
            if not login:
                raise RuntimeError("Twitch user info response did not include a login value")
        except Exception as e:
            log.warning("[canvas-public] auth failed: %s", e)
            self.set_status(400)
            self.write("<h1>Authorization failed</h1><p>Could not verify your Twitch account.</p>")
            return

        session_id = secrets.token_urlsafe(24)
        state.canvas_public_sessions[session_id] = {
            "username": login,
            "access_token": access_token,
            "created_at": time.time(),
        }
        self.set_cookie(CANVAS_PUBLIC_COOKIE, session_id, httponly=True, samesite="Lax", max_age=30 * 24 * 60 * 60)
        self.redirect(f"{CANVAS_PUBLIC_BASE_URL}/?logged_in=1")


class CanvasPublicSessionHandler(tornado.web.RequestHandler):
    """returns the authenticated Twitch login for the current public-canvas session."""

    def get(self) -> None:
        session_id = self.get_cookie(CANVAS_PUBLIC_COOKIE)
        session = state.canvas_public_sessions.get(session_id)
        if not session:
            self.set_status(401)
            self.write(json.dumps({"logged_in": False, "error": "not logged in"}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"logged_in": True, "username": session["username"]}))


class CanvasPublicStateHandler(tornado.web.RequestHandler):
    """read-only snapshot of the current canvas for the public draw page."""

    def get(self) -> None:
        canvas = state.data.get("canvas", {})
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({
            "size": canvas.get("size", 100),
            "visible": canvas.get("visible", False),
            "pixels": canvas.get("pixels", {}),
            "owners": canvas.get("owners", {}),
        }))


class CanvasPublicPlaceHandler(tornado.web.RequestHandler):
    """places a pixel from a logged-in public viewer session."""

    def post(self) -> None:
        session_id = self.get_cookie(CANVAS_PUBLIC_COOKIE)
        session = state.canvas_public_sessions.get(session_id)
        if not session:
            self.set_status(401)
            self.write(json.dumps({"error": "please sign in with Twitch"}))
            return

        try:
            body = json.loads(self.request.body.decode("utf-8") or "{}")
        except Exception:
            self.set_status(400)
            self.write(json.dumps({"error": "bad json"}))
            return

        try:
            x = int(body.get("x"))
            y = int(body.get("y"))
            color = str(body.get("color") or "")
        except Exception:
            self.set_status(400)
            self.write(json.dumps({"error": "x, y, and color are required"}))
            return

        ok, msg = place_public_pixel(session["username"], x, y, color)
        if not ok:
            self.set_status(400)
            self.write(json.dumps({"error": msg}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True, "message": msg, "user": session["username"]}))


class LayoutsListHandler(tornado.web.RequestHandler):
    """lists saved layout configs (by filename stem) in LAYOUTS_DIR, so
    control.html can offer a dropdown of saved configs (e.g. '16:9',
    '4:3-retro')."""

    def get(self) -> None:
        names = sorted(
            p.stem for p in LAYOUTS_DIR.iterdir()
            if p.is_file() and p.suffix.lower() == ".json"
        ) if LAYOUTS_DIR.exists() else []
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"names": names}))


class LayoutSaveHandler(tornado.web.RequestHandler):
    """saves the current (or posted) layout array under a name, so it can
    be recalled later. expects JSON body {"name": "...", "layout": [...]}"""

    def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except Exception:
            self.set_status(400)
            self.write(json.dumps({"error": "bad json"}))
            return
        name = re.sub(r"[^\w\-: ]", "_", (body.get("name") or "").strip())[:60]
        layout = body.get("layout")
        if not name or not isinstance(layout, list):
            self.set_status(400)
            self.write(json.dumps({"error": "name and layout[] required"}))
            return
        LAYOUTS_DIR.mkdir(parents=True, exist_ok=True)
        path = LAYOUTS_DIR / f"{name}.json"
        try:
            path.write_text(json.dumps(layout, indent=2), encoding="utf-8")
        except Exception as e:
            self.set_status(500)
            self.write(json.dumps({"error": str(e)}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True, "name": name}))


class LayoutLoadHandler(tornado.web.RequestHandler):
    """loads a named layout config. GET /layout-load?name=..."""

    def get(self) -> None:
        name = re.sub(r"[^\w\-: ]", "_", (self.get_argument("name", "") or "").strip())[:60]
        path = LAYOUTS_DIR / f"{name}.json"
        if not name or not path.exists():
            self.set_status(404)
            self.write(json.dumps({"error": "not found"}))
            return
        try:
            layout = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            self.set_status(500)
            self.write(json.dumps({"error": str(e)}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True, "name": name, "layout": layout}))


class LayoutDeleteHandler(tornado.web.RequestHandler):
    """deletes a named layout config. expects JSON body {"name": "..."}"""

    def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except Exception:
            body = {}
        name = re.sub(r"[^\w\-: ]", "_", (body.get("name") or "").strip())[:60]
        path = LAYOUTS_DIR / f"{name}.json"
        try:
            if path.exists():
                path.unlink()
            self.set_header("Content-Type", "application/json")
            self.write(json.dumps({"ok": True}))
        except Exception as e:
            self.set_status(500)
            self.write(json.dumps({"error": str(e)}))


class PngtuberDeleteHandler(tornado.web.RequestHandler):
    """delete one pngtuber image, e.g. from the control panel's pngtuber
    manager. expects JSON body {"state": "...", "file": "..."}."""

    def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except Exception:
            self.set_status(400)
            self.write(json.dumps({"error": "bad json"}))
            return
        pstate = body.get("state", "")
        fname = body.get("file", "")
        if pstate not in PNGTUBER_STATES or not fname or "/" in fname or "\\" in fname:
            self.set_status(400)
            self.write(json.dumps({"error": "invalid state/file"}))
            return
        path = PNGTUBER_DIR / pstate / fname
        try:
            if path.exists():
                path.unlink()
            self.set_header("Content-Type", "application/json")
            self.write(json.dumps({"ok": True}))
        except Exception as e:
            self.set_status(500)
            self.write(json.dumps({"error": str(e)}))


class PngtuberFolderHandler(tornado.web.RequestHandler):
    """opens the pngtuber state folder in the OS file explorer, so images
    can be dropped in without building an upload UI."""

    def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except Exception:
            body = {}
        pstate = body.get("state", "")
        if pstate not in PNGTUBER_STATES:
            self.set_status(400)
            self.write(json.dumps({"error": "invalid state"}))
            return
        path = PNGTUBER_DIR / pstate
        path.mkdir(parents=True, exist_ok=True)
        try:
            if sys.platform == "win32":
                os.startfile(str(path))
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
            self.write(json.dumps({"ok": True}))
        except Exception as e:
            self.set_status(500)
            self.write(json.dumps({"error": str(e)}))


class PngtuberUploadHandler(tornado.web.RequestHandler):
    """multipart image upload for a pngtuber state, from the control panel's
    'upload' button — an alternative to manually dropping files in via
    the 'open folder' button."""

    def post(self) -> None:
        pstate = self.get_body_argument("state", "")
        if pstate not in PNGTUBER_STATES:
            self.set_status(400)
            self.write(json.dumps({"error": "invalid state"}))
            return
        files = self.request.files.get("file", [])
        if not files:
            self.set_status(400)
            self.write(json.dumps({"error": "no file uploaded"}))
            return
        target_dir = PNGTUBER_DIR / pstate
        target_dir.mkdir(parents=True, exist_ok=True)

        saved = []
        for f in files:
            fname = f["filename"]
            ext = pathlib.Path(fname).suffix.lower()
            if ext not in (".png", ".gif", ".webp", ".jpg", ".jpeg"):
                continue
            safe_name = re.sub(r"[^\w\.\-]", "_", fname)[:80] or "upload.png"
            dest = target_dir / safe_name
            i = 1
            while dest.exists():
                dest = target_dir / f"{pathlib.Path(safe_name).stem}_{i}{ext}"
                i += 1
            try:
                dest.write_bytes(f["body"])
                saved.append(dest.name)
            except Exception as e:
                log.warning("[pngtuber] failed to save upload %s: %s", fname, e)

        if not saved:
            self.set_status(400)
            self.write(json.dumps({"error": "no valid image files (png/gif/webp/jpg)"}))
            return
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True, "saved": saved}))


def start_http_server() -> None:
    _ensure_redeem_player_html()
    app = tornado.web.Application([
        (r"/pngtuber", OverlayHandler, {"filename": "pngtuber.html"}),
        (r"/pngtuber-assets/(.*)", tornado.web.StaticFileHandler, {"path": str(PNGTUBER_DIR)}),
        (r"/pngtuber-list", PngtuberAssetsHandler),
        (r"/pngtuber-delete", PngtuberDeleteHandler),
        (r"/pngtuber-folder", PngtuberFolderHandler),
        (r"/pngtuber-upload", PngtuberUploadHandler),
        (r"/(.*\.png)", tornado.web.StaticFileHandler, {"path": str(BASE_DIR)}),
        (r"/overlay", OverlayHandler, {"filename": "overlay.html"}),
        (r"/chat", OverlayHandler, {"filename": "chat.html"}),
        (r"/music", OverlayHandler, {"filename": "music.html"}),
        (r"/scene", OverlayHandler, {"filename": "scene.html"}),
        (r"/redeem-player", OverlayHandler, {"filename": "redeem-player.html"}),
        (r"/media/(.*)", tornado.web.StaticFileHandler, {"path": str(MEDIA_DIR)}),
        (r"/media-list", MediaListHandler),
        (r"/mv-cache/(.*)", tornado.web.StaticFileHandler, {"path": str(MV_CACHE_DIR)}),
        (r"/tts-voices", TTSVoicesHandler),
        (r"/wos-login", WOSLoginHandler),
        (r"/state", CommandsHandler),
        (r"/layouts-list", LayoutsListHandler),
        (r"/layout-save", LayoutSaveHandler),
        (r"/layout-load", LayoutLoadHandler),
        (r"/layout-delete", LayoutDeleteHandler),
        (r"/control", OverlayHandler, {"filename": "control.html"}),
        (r"/stream", OverlayHandler, {"filename": "control.html"}),
        (r"/", OverlayHandler, {"filename": "control.html"}),
        (r"/(.*)", OverlayStaticHandler),
    ])
    app.listen(HTTP_PORT)

    public_app = tornado.web.Application([
        (r"/canvas/login", CanvasPublicLoginHandler),
        (r"/canvas/callback", CanvasPublicCallbackHandler),
        (r"/canvas/session", CanvasPublicSessionHandler),
        (r"/canvas/state", CanvasPublicStateHandler),
        (r"/canvas/place", CanvasPublicPlaceHandler),
        (r"/canvas", CanvasPublicPageHandler),
        (r"/", CanvasPublicPageHandler),
    ])
    public_app.listen(CANVAS_PUBLIC_PORT)

    log.info("http overlays at http://localhost:%d/{overlay,chat,music,scene,pngtuber}", HTTP_PORT)
    log.info("http control panel at http://localhost:%d/  (or /control, /stream)", HTTP_PORT)
    log.info("public canvas at http://localhost:%d/  (Twitch auth + pixel place page)", CANVAS_PUBLIC_PORT)
    log.info("overlay files searched in order: %s", [str(d) for d in OVERLAY_SEARCH_DIRS])
    tornado.ioloop.IOLoop.current().start()