import json
import os
import pathlib
import re
import subprocess
import sys

import tornado.ioloop
import tornado.web

from config import log, BASE_DIR, OVERLAY_DIR, PNGTUBER_DIR, PNGTUBER_STATES, MEDIA_DIR, MEDIA_EXTS, HTTP_PORT
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
    """writes redeem-player.html into OVERLAY_DIR, so /redeem-player works
    out of the box as an OBS browser source without you having to hand-
    author it. always overwrites — if you've customized the file yourself,
    rename it (e.g. redeem-player.custom.html) and point OBS at that
    instead, otherwise your edits get clobbered on every restart."""
    try:
        OVERLAY_DIR.mkdir(parents=True, exist_ok=True)
        path = OVERLAY_DIR / "redeem-player.html"
        path.write_text(_REDEEM_PLAYER_HTML, encoding="utf-8")
        log.info("[redeems] wrote redeem-player.html to %s", path)
    except Exception as e:
        log.warning("[redeems] could not write redeem-player.html: %s", e)


class OverlayHandler(tornado.web.RequestHandler):
    def initialize(self, filename: str, directory: pathlib.Path = OVERLAY_DIR) -> None:
        self.filename = filename
        self.directory = directory

    def get(self) -> None:
        path = self.directory / self.filename
        if path.exists():
            self.set_header("Content-Type", "text/html; charset=utf-8")
            self.write(path.read_text(encoding="utf-8"))
        else:
            self.set_status(404)
            self.write(f"not found: {self.filename}")


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
        (r"/pngtuber", OverlayHandler, {"filename": "pngtuber.html", "directory": OVERLAY_DIR}),
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
        (r"/redeem-player", OverlayHandler, {"filename": "redeem-player.html", "directory": OVERLAY_DIR}),
        (r"/media/(.*)", tornado.web.StaticFileHandler, {"path": str(MEDIA_DIR)}),
        (r"/media-list", MediaListHandler),
        (r"/tts-voices", TTSVoicesHandler),
        (r"/state", CommandsHandler),
        (r"/control", OverlayHandler, {"filename": "control.html", "directory": OVERLAY_DIR}),
        (r"/stream", OverlayHandler, {"filename": "control.html", "directory": OVERLAY_DIR}),
        (r"/", OverlayHandler, {"filename": "control.html", "directory": OVERLAY_DIR}),
        (r"/(.*)", tornado.web.StaticFileHandler, {"path": str(OVERLAY_DIR)}),
    ])
    app.listen(HTTP_PORT)
    log.info("http overlays at http://localhost:%d/{overlay,chat,music,scene,pngtuber}", HTTP_PORT)
    log.info("http control panel at http://localhost:%d/  (or /control, /stream)", HTTP_PORT)
    tornado.ioloop.IOLoop.current().start()
