"""Streamd integration for the standalone player's local HTTP API."""
import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from config import log, BASE_DIR, MUSIC_DIR, PLAYER_API_URL
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic, write_bytes_atomic

ART_EXTS = (".jpg", ".jpeg", ".png", ".webp")

_last_key = None
_request_ids: list[str] = []
_reached: set[str] = set()


def _api(path: str, payload: dict | None = None, timeout: float = 5) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{PLAYER_API_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="GET" if data is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"player API returned HTTP {error.code}: {detail}") from error
    if not isinstance(result, dict):
        raise RuntimeError("player API returned a non-object response")
    return result


def _to_uri(path: str | Path) -> str | None:
    value = Path(path)
    if not value.is_absolute():
        value = MUSIC_DIR / value
    try:
        return value.resolve().relative_to(MUSIC_DIR.resolve()).as_posix()
    except ValueError:
        return None


def _set_idle() -> None:
    global _last_key
    previous = state.data.get("music") or {}
    if previous.get("uri") is None and previous.get("title") == "—":
        return
    _last_key = None
    music = {
        "title": "—",
        "artist": "",
        "playing": False,
        "duration": 0,
        "position": 0,
        "video_url": None,
        "uri": None,
    }
    state.data["music"] = music
    broadcast_sync({"type": "music", **music})


def _update_art(uri: str) -> None:
    def _worker() -> None:
        try:
            data = None
            for extension in ART_EXTS:
                sidecar = (MUSIC_DIR / uri).with_suffix(extension)
                if sidecar.is_file():
                    data = sidecar.read_bytes()
                    break
            if data:
                write_bytes_atomic(BASE_DIR / "art.png", data)
            else:
                log.info("[player] no sidecar art for %s", uri)
        except OSError as error:
            log.warning("[player] art read failed for %s: %s", uri, error)

    threading.Thread(target=_worker, daemon=True, name="player-art").start()


def _cleanup_requests(current_id: str | None) -> None:
    from song_requests import mark_request

    if current_id in _request_ids:
        _reached.add(current_id)
        mark_request(current_id, "playing")
    for entry_id in list(_reached):
        if entry_id == current_id:
            continue
        try:
            _api("/api/v1/control", {"action": "remove", "id": entry_id})
        except Exception as error:
            log.warning("[player] failed to remove completed request %s: %s", entry_id, error)
        _reached.discard(entry_id)
        if entry_id in _request_ids:
            _request_ids.remove(entry_id)
        mark_request(entry_id, "played")


def _refresh() -> None:
    global _last_key
    from commands import fetch_and_broadcast_lyrics

    snapshot = _api("/api/v1/status")
    if snapshot.get("state") == "stop" or not snapshot.get("uri"):
        stopped_id = snapshot.get("id")
        if stopped_id is not None and str(stopped_id) in _request_ids:
            _reached.add(str(stopped_id))
        _cleanup_requests(None)
        _set_idle()
        return

    entry_id = snapshot.get("id")
    _cleanup_requests(str(entry_id) if entry_id is not None else None)
    uri = str(snapshot["uri"])
    title = str(snapshot.get("title") or Path(uri).stem)
    artist = str(snapshot.get("artist") or "")
    if not artist and " - " in title:
        artist, title = title.split(" - ", 1)
    music = {
        "title": title,
        "artist": artist,
        "playing": bool(snapshot.get("playing")),
        "duration": float(snapshot.get("duration") or 0),
        "position": float(snapshot.get("position") or 0),
        "video_url": state.data.get("music", {}).get("video_url"),
        "uri": uri,
    }
    key = (uri, title, artist)
    if key != _last_key:
        _last_key = key
        from library import find_sidecars, ensure_music_video

        music["video_url"] = find_sidecars(uri)["video_url"]
        state.data["music"] = music
        broadcast_sync({"type": "music", **music})
        broadcast_sync({"type": "music_video", "url": music["video_url"]})
        write_atomic(BASE_DIR / "music", f"{title}\nby {artist}")
        _update_art(uri)
        fetch_and_broadcast_lyrics(artist, title, uri=uri)
        if not music["video_url"]:
            ensure_music_video(uri, title, artist)
        return
    state.data["music"] = music
    broadcast_sync({"type": "music", **music})


def run_player_thread() -> None:
    connected = False
    while True:
        try:
            _api("/health")
            if not connected:
                log.info("[player] connected to %s", PLAYER_API_URL)
                connected = True
            _refresh()
            time.sleep(1)
        except Exception as error:
            connected = False
            log.warning("[player] API unavailable: %s - retrying in 5s", error)
            _set_idle()
            time.sleep(5)


def media_control(action: str) -> None:
    if action not in ("play", "pause", "toggle", "next", "prev"):
        log.warning("[player] unknown media action %r", action)
        return
    try:
        _api("/api/v1/control", {"action": action})
    except Exception as error:
        log.warning("[player] media_control %s failed: %s", action, error)


def play_file(path: str | Path, mode: str = "insert-next") -> str | None:
    """Queue a file under the shared music directory and return its player ID."""
    if mode not in ("insert-next", "append", "replace"):
        raise ValueError(mode)
    uri = _to_uri(path)
    if uri is None:
        log.warning("[player] %s is outside the music directory %s", path, MUSIC_DIR)
        return None
    try:
        result = _api(
            "/api/v1/queue",
            {"path": str(MUSIC_DIR / Path(uri)), "mode": mode},
        )
        entry_id = str(result["id"])
        if mode == "insert-next":
            _request_ids.append(entry_id)
        return entry_id
    except Exception as error:
        log.warning("[player] play_file failed for %s: %s", path, error)
        return None


def _playlist_file(name: str) -> Path:
    if not name or name in (".", "..") or Path(name).name != name:
        raise ValueError(f"invalid playlist name: {name!r}")
    root_playlist = MUSIC_DIR / f"{name}.m3u"
    if root_playlist.is_file():
        return root_playlist
    return MUSIC_DIR / name / f"{name}.m3u"


def list_playlists() -> list[str]:
    if not MUSIC_DIR.exists():
        return []
    names = {
        path.stem
        for path in MUSIC_DIR.iterdir()
        if path.is_file() and path.suffix.lower() == ".m3u"
    }
    names.update(
        directory.name
        for directory in MUSIC_DIR.iterdir()
        if directory.is_dir()
        and (directory / f"{directory.name}.m3u").is_file()
    )
    return sorted(names)


def _read_m3u(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text(encoding="cp1252", errors="replace")
    paths = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entry = Path(line)
        if not entry.is_absolute():
            entry = path.parent / entry
        uri = _to_uri(entry)
        if uri:
            paths.append(str(MUSIC_DIR / Path(uri)))
    return paths


def load_playlist(name: str, shuffle: bool = False, skip: bool = False) -> bool:
    try:
        paths = _read_m3u(_playlist_file(name))
        _api(
            "/api/v1/playlist",
            {"paths": paths, "shuffle": bool(shuffle), "skip": bool(skip)},
        )
        log.info("[player] loaded playlist %r: %d tracks", name, len(paths))
        return bool(paths)
    except Exception as error:
        log.warning("[player] load_playlist %r failed: %s", name, error)
        return False
