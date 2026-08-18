"""
ytmusic_bridge.py — Refactored to match the OpenAPI 3.1.0 specification.

- Auth: POST /auth/{appId} -> returns accessToken
- Live State: ws://{host}:{port}/api/v1/ws?token={accessToken}
- Control: REST API endpoints under /api/v1/*
"""

import asyncio
import hashlib
import json
import threading
import time
import urllib.request

from config import (
    log, BASE_DIR, YTM_COMPANION_HOST, YTM_COMPANION_PORT,
    YTM_COMPANION_TOKEN_PATH, YTM_COMPANION_APP_ID, YTM_AUTH_HEADERS_PATH,
    MV_CACHE_DIR, MV_MAX_CACHE_BYTES, MV_DOWNLOAD_ENABLED,
)
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic, write_bytes_atomic


# Fix 0.0.0.0 outgoing connection error on Windows
def _get_target_host() -> str:
    host = YTM_COMPANION_HOST
    if host in ("0.0.0.0", "", "::"):
        return "127.0.0.1"
    return host


# ── REST API Helpers ───────────────────────────────────────────────────

def _get_base_url() -> str:
    return f"http://{_get_target_host()}:{YTM_COMPANION_PORT}"


def _api_request(method: str, path: str, payload: dict | None = None) -> dict | None:
    token = load_companion_token()
    url = _get_base_url() + path
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 204:
                return {}
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except Exception as e:
        log.warning("[ytm] REST %s %s failed: %s", method, path, e)
        return None


# ── Companion Token (Pairing) ──────────────────────────────────────────

def load_companion_token() -> str | None:
    if YTM_COMPANION_TOKEN_PATH.exists():
        try:
            data = json.loads(YTM_COMPANION_TOKEN_PATH.read_text(encoding="utf-8"))
            return data.get("token")
        except Exception as e:
            log.warning("[ytm] failed to read companion token: %s", e)
    return None


def save_companion_token(token: str) -> None:
    try:
        YTM_COMPANION_TOKEN_PATH.write_text(json.dumps({"token": token}, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("[ytm] failed to save companion token: %s", e)


def run_companion_pairing_flow() -> None:
    """Authentication matching `POST /auth/{id}`."""
    app_id = YTM_COMPANION_APP_ID or "streamd"
    url = f"{_get_base_url()}/auth/{app_id}"

    print(f"Requesting auth token from pear-desktop at {url} ...")
    req = urllib.request.Request(url, data=b"", headers={"Content-Type": "application/json"}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            token = result.get("accessToken")
            if not token:
                print(f"Auth failed. Response missing accessToken: {result}")
                return
            save_companion_token(token)
            print(f"Successfully authenticated! Token saved to {YTM_COMPANION_TOKEN_PATH}")
    except Exception as e:
        print(f"Authentication failed — check if pear-desktop is running and host/port are correct: {e}")


# ── Native WebSocket Client (Live State Updates) ──────────────────────

class _YtmCompanion:
    """Connects to the native WebSocket endpoint /api/v1/ws."""

    def __init__(self) -> None:
        self.loop = None
        self.ws = None
        self.connected = False

    def connect_forever(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._main_loop())

    async def _main_loop(self) -> None:
        import websockets

        token = load_companion_token()
        if not token:
            log.warning("[ytm] no companion token — run `python run.py --ytm-auth` first")
            return

        host = _get_target_host()
        uri = f"ws://{host}:{YTM_COMPANION_PORT}/api/v1/ws?token={token}"

        while True:
            try:
                log.info("[ytm] connecting to WebSocket at %s...", uri)
                async with websockets.connect(uri) as ws:
                    self.ws = ws
                    self.connected = True
                    log.info("[ytm] WebSocket connected")

                    async for message in ws:
                        try:
                            data = json.loads(message)
                            _handle_state_update(data)
                        except Exception as parse_err:
                            log.warning("[ytm] failed to parse ws payload: %s", parse_err)

            except Exception as e:
                self.connected = False
                self.ws = None
                log.warning("[ytm] WebSocket error: %s — retrying in 5s", e)
                _set_idle()
                await asyncio.sleep(5)


_companion = _YtmCompanion()
_last_title = ""


def _set_idle() -> None:
    music = {"title": "—", "artist": "", "playing": False, "duration": 0, "position": 0}
    state.data["music"] = music
    broadcast_sync({"type": "music", **music})


def _handle_state_update(data: dict) -> None:
    global _last_title

    from commands import fetch_and_broadcast_lyrics

    # Parse payloads conforming to the /api/v1/song and /api/v1/ws structures
    title = data.get("title") or ""
    artist = data.get("artist") or ""
    duration = float(data.get("songDuration") or 0)
    position = float(data.get("elapsedSeconds") or 0)
    playing = not data.get("isPaused", True)

    if not title:
        _set_idle()
        return

    music = {"title": title, "artist": artist, "playing": playing, "duration": duration, "position": position}
    state.data["music"] = music
    broadcast_sync({"type": "music", **music})

    if title != _last_title:
        _last_title = title
        write_atomic(BASE_DIR / "music", f"{title}\nby {artist}")
        _fetch_and_cache_art(data)
        fetch_and_broadcast_lyrics(artist, title)

        video_id = data.get("videoId")
        if MV_DOWNLOAD_ENABLED and video_id:
            cached = _mv_path_for(video_id)
            if cached.exists():
                url = f"/mv-cache/{cached.name}"
                state.data["music"]["video_url"] = url
                broadcast_sync({"type": "music_video", "url": url})
            else:
                state.data["music"]["video_url"] = None
                broadcast_sync({"type": "music_video", "url": None})
                _mv_download(video_id, title, artist)
        else:
            state.data["music"]["video_url"] = None


def _fetch_and_cache_art(data: dict) -> None:
    url = data.get("imageSrc")
    if not url:
        return

    def _worker() -> None:
        try:
            with urllib.request.urlopen(url, timeout=6) as resp:
                data_bytes = resp.read()
            write_bytes_atomic(BASE_DIR / "art.png", data_bytes)
            log.info("[ytm] art.png updated")
        except Exception as e:
            log.warning("[ytm] art fetch failed: %s", e)

    threading.Thread(target=_worker, daemon=True, name="ytm-art-fetch").start()


def run_ytmusic_thread() -> None:
    _companion.connect_forever()


def media_control(action: str) -> None:
    """Dispatches media commands via OpenAPI HTTP endpoints."""
    routes = {
        "play": "/api/v1/play",
        "pause": "/api/v1/pause",
        "toggle": "/api/v1/toggle-play",
        "next": "/api/v1/next",
        "prev": "/api/v1/previous",
    }
    path = routes.get(action)
    if path:
        _api_request("POST", path)
    else:
        log.warning("[ytm] unknown media action %r", action)


# ── Music Video Caching (yt-dlp) ────────────────────────────────────────

_mv_inflight: set[str] = set()
_mv_inflight_lock = threading.Lock()


def _mv_cache_key(video_id: str) -> str:
    return hashlib.sha1(video_id.encode("utf-8")).hexdigest()[:16]


def _mv_path_for(video_id: str):
    return MV_CACHE_DIR / f"{_mv_cache_key(video_id)}.mp4"


def _mv_trim_cache() -> None:
    files = sorted(MV_CACHE_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while total > MV_MAX_CACHE_BYTES and files:
        victim = files.pop(0)
        try:
            total -= victim.stat().st_size
            victim.unlink()
            log.info("[mv-cache] evicted %s", victim.name)
        except Exception:
            pass


def _mv_download(video_id: str, title: str, artist: str) -> None:
    dest = _mv_path_for(video_id)
    if dest.exists():
        broadcast_sync({"type": "music_video", "url": f"/mv-cache/{dest.name}"})
        return

    with _mv_inflight_lock:
        if video_id in _mv_inflight:
            return
        _mv_inflight.add(video_id)

    def _worker() -> None:
        try:
            import yt_dlp
        except ImportError:
            log.info("[mv-cache] yt-dlp not installed — skipping mv download")
            with _mv_inflight_lock:
                _mv_inflight.discard(video_id)
            return

        import os as _os
        tmp = str(dest) + ".part"
        ydl_opts = {
            "format": "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]",
            "outtmpl": tmp,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([f"https://music.youtube.com/watch?v={video_id}"])

            if _os.path.exists(tmp):
                _os.replace(tmp, str(dest))
            else:
                candidates = list(MV_CACHE_DIR.glob(f"{dest.stem}.mp4.part*")) + \
                             list(MV_CACHE_DIR.glob(f"{dest.stem}.part*"))
                if candidates:
                    _os.replace(str(candidates[0]), str(dest))
                else:
                    raise FileNotFoundError("yt-dlp finished but no output file found")

            log.info("[mv-cache] cached mv for %s - %s (%s)", artist, title, dest.name)
            _mv_trim_cache()
            url = f"/mv-cache/{dest.name}"
            if state.data.get("music", {}).get("title") == title:
                state.data["music"]["video_url"] = url
                broadcast_sync({"type": "music_video", "url": url})
        except Exception as e:
            log.info("[mv-cache] no video found / download failed for %r - %r: %s", artist, title, e)
        finally:
            with _mv_inflight_lock:
                _mv_inflight.discard(video_id)

    threading.Thread(target=_worker, daemon=True, name="mv-download").start()


# ── Search (ytmusicapi) — Song Request Redeem ───────────────────────────

_ytmusic_client = None
_ytmusic_lock = threading.Lock()


def _get_ytmusic_client():
    global _ytmusic_client
    with _ytmusic_lock:
        if _ytmusic_client is None:
            from ytmusicapi import YTMusic
            if not YTM_AUTH_HEADERS_PATH.exists():
                log.warning("[ytm] no auth headers at %s — run `python -m ytmusicapi browser`", YTM_AUTH_HEADERS_PATH)
                _ytmusic_client = YTMusic()
            else:
                _ytmusic_client = YTMusic(str(YTM_AUTH_HEADERS_PATH))
        return _ytmusic_client


def search_song(query: str) -> dict | None:
    try:
        yt = _get_ytmusic_client()
        results = yt.search(query, filter="songs", limit=5)
        if not results:
            results = yt.search(query, filter="videos", limit=5)
        if not results:
            return None
        top = results[0]
        artists = top.get("artists") or []
        return {
            "videoId": top.get("videoId"),
            "title": top.get("title", ""),
            "artist": ", ".join(a.get("name", "") for a in artists if a.get("name")),
            "duration": top.get("duration", ""),
        }
    except Exception as e:
        log.warning("[ytm] search failed for %r: %s", query, e)
        return None


def request_song(query: str, user: str) -> tuple[bool, str]:
    match = search_song(query)
    if not match or not match.get("videoId"):
        return False, f"couldn't find a song matching {query!r}"

    # Queue video using POST /api/v1/queue
    res = _api_request("POST", "/api/v1/queue", {"videoId": match["videoId"]})
    if res is None:
        return False, "Failed to queue song via companion API"

    label = f'{match["title"]} — {match["artist"]}' if match["artist"] else match["title"]
    return True, f'{user} queued "{label}"'