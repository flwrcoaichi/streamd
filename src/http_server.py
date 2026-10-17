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
    CANVAS_PUBLIC_COOKIE_DOMAIN, REQUESTS_PUBLIC_PORT, MUSIC_DIR,
    REQUESTS_PUBLIC_BASE_URL,
    CANVAS_PUBLIC_REDIRECT_URI, CANVAS_PUBLIC_TWITCH_SCOPE,
)
from canvas import place_public_pixel, get_credits, is_unlimited
from state import state
from song_requests import search_youtube, submit_request, get_song_credits


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


class SidecarHandler(tornado.web.StaticFileHandler):
    """serves only video/lyric sidecars from the music dir (supports range requests)."""
    ALLOWED = {".mp4", ".webm", ".mkv", ".mov", ".lrc", ".ttml"}

    def validate_absolute_path(self, root, absolute_path):
        if pathlib.Path(absolute_path).suffix.lower() not in self.ALLOWED:
            raise tornado.web.HTTPError(404)
        return super().validate_absolute_path(root, absolute_path)
    
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


class CanvasPublicLoginHandler(tornado.web.RequestHandler):
    """redirects viewers to the Twitch OAuth page for public canvases."""

    def get(self) -> None:
        if not TWITCH_CLIENT_ID:
            self.set_status(503)
            self.write(json.dumps({"error": "TWITCH_CLIENT_ID is not configured for public canvas auth"}))
            return
        redirect_uri = CANVAS_PUBLIC_REDIRECT_URI
        auth_url = (
            "https://id.twitch.tv/oauth2/authorize"
            f"?client_id={urllib.parse.quote(TWITCH_CLIENT_ID)}"
            f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
            "&response_type=code"
            f"&scope={urllib.parse.quote(CANVAS_PUBLIC_TWITCH_SCOPE)}"
        )
        nxt = self.get_argument("next", "")
        if nxt in ("canvas", "requests"):
            self.set_cookie("streamd_login_next", nxt, httponly=True, samesite="Lax", max_age=600)
        else:
            self.clear_cookie("streamd_login_next")
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
            redirect_uri = CANVAS_PUBLIC_REDIRECT_URI
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
        self.set_cookie(
            CANVAS_PUBLIC_COOKIE, session_id, httponly=True, samesite="Lax",
            max_age=30 * 24 * 60 * 60,
            domain=CANVAS_PUBLIC_COOKIE_DOMAIN or None,
        )
        next_page = self.get_cookie("streamd_login_next")
        self.clear_cookie("streamd_login_next")
        if next_page == "requests":
            self.redirect(f"{REQUESTS_PUBLIC_BASE_URL.rstrip('/')}/?logged_in=1")
        else:
            self.redirect(f"{CANVAS_PUBLIC_BASE_URL.rstrip('/')}/?logged_in=1")


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
        name = session["username"]
        self.write(json.dumps({
            "logged_in": True, "username": name,
            "credits": get_credits(name), "unlimited": is_unlimited(name),
        }))


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


class CanvasPublicLogoutHandler(tornado.web.RequestHandler):
    def post(self) -> None:
        state.canvas_public_sessions.pop(self.get_cookie(CANVAS_PUBLIC_COOKIE), None)
        self.clear_cookie(CANVAS_PUBLIC_COOKIE, domain=CANVAS_PUBLIC_COOKIE_DOMAIN or None)
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True}))


class RequestsLoginHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        self.redirect(f"{CANVAS_PUBLIC_BASE_URL.rstrip('/')}/canvas/login?next=requests")


class RequestsUrlHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"url": REQUESTS_PUBLIC_BASE_URL.rstrip("/") + "/"}))


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

_last_search: dict[str, float] = {}


def _viewer(handler):
    return state.canvas_public_sessions.get(handler.get_cookie(CANVAS_PUBLIC_COOKIE) or "")


def _json(handler, data, status=200):
    handler.set_status(status)
    handler.set_header("Content-Type", "application/json")
    handler.write(json.dumps(data))


class RequestsSessionHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        s = _viewer(self)
        if not s:
            return _json(self, {"logged_in": False, "error": "not logged in"}, 401)
        name = s["username"]
        _json(self, {"logged_in": True, "username": name,
                     "credits": get_song_credits(name), "unlimited": is_unlimited(name)})


class RequestsSearchHandler(tornado.web.RequestHandler):
    async def get(self) -> None:
        s = _viewer(self)
        if not s:
            return _json(self, {"error": "please sign in with Twitch"}, 401)
        q = self.get_argument("q", "").strip()
        if len(q) < 2:
            return _json(self, {"error": "type at least 2 characters"}, 400)
        now = time.time()
        if now - _last_search.get(s["username"], 0) < 2:
            return _json(self, {"error": "slow down a little"}, 429)
        _last_search[s["username"]] = now
        try:
            results = await tornado.ioloop.IOLoop.current().run_in_executor(None, search_youtube, q)
        except Exception as e:
            log.warning("[requests] search failed: %s", e)
            return _json(self, {"error": str(e)}, 502)
        _json(self, {"results": results})


class RequestsSubmitHandler(tornado.web.RequestHandler):
    def post(self) -> None:
        s = _viewer(self)
        if not s:
            return _json(self, {"error": "please sign in with Twitch"}, 401)
        try:
            body = json.loads(self.request.body.decode("utf-8") or "{}")
        except Exception:
            return _json(self, {"error": "bad json"}, 400)
        ok, msg = submit_request(s["username"], str(body.get("query") or ""))
        _json(self, {"ok": True, "message": msg} if ok else {"error": msg}, 200 if ok else 400)


class RequestsQueueHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        music = state.data.get("music", {})
        _json(self, {
            "now": {"title": music.get("title", ""), "artist": music.get("artist", "")},
            "requests": [{"user": r["user"], "title": r["title"], "status": r["status"], "error": r["error"]}
                         for r in state.data.get("requests", [])],
        })

def start_http_server() -> None:
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
        (r"/music-media/(.*)", SidecarHandler, {"path": str(MUSIC_DIR)}),
        (r"/tts-voices", TTSVoicesHandler),
        (r"/wos-login", OverlayHandler, {"filename": "wos-login.html"}),
        (r"/state", CommandsHandler),
        (r"/requests-url", RequestsUrlHandler),
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

    canvas_app = tornado.web.Application([
        (r"/canvas/login", CanvasPublicLoginHandler),
        (r"/canvas/callback", CanvasPublicCallbackHandler),
        (r"/canvas/session", CanvasPublicSessionHandler),
        (r"/canvas/state", CanvasPublicStateHandler),
        (r"/canvas/place", CanvasPublicPlaceHandler),
        (r"/canvas/logout", CanvasPublicLogoutHandler),
        (r"/canvas/?", OverlayHandler, {"filename": "canvas-public.html"}),
        (r"/", OverlayHandler, {"filename": "canvas-public.html"}),
    ])
    canvas_app.listen(CANVAS_PUBLIC_PORT)

    requests_app = tornado.web.Application([
        (r"/requests/session", RequestsSessionHandler),
        (r"/requests/search", RequestsSearchHandler),
        (r"/requests/submit", RequestsSubmitHandler),
        (r"/requests/queue", RequestsQueueHandler),
        (r"/requests/?", OverlayHandler, {"filename": "requests.html"}),
        (r"/", OverlayHandler, {"filename": "requests.html"}),
        (r"/login", RequestsLoginHandler),
        (r"/logout", CanvasPublicLogoutHandler),
    ])
    requests_app.listen(REQUESTS_PUBLIC_PORT)

    log.info("http overlays at http://localhost:%d/{overlay,chat,music,scene,pngtuber}", HTTP_PORT)
    log.info("http control panel at http://localhost:%d/  (or /control, /stream)", HTTP_PORT)
    log.info("public canvas at %s  (Twitch auth + pixel place page)", CANVAS_PUBLIC_BASE_URL)
    log.info("public song requests at %s", REQUESTS_PUBLIC_BASE_URL)
    log.info("overlay files searched in order: %s", [str(d) for d in OVERLAY_SEARCH_DIRS])
    tornado.ioloop.IOLoop.current().start()