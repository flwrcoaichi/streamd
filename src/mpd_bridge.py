"""
mpd_bridge.py - music playback state + control via MPD, replacing ytmusic_bridge.py.

MPD runs as its own daemon (so ncmpcpp etc. keep working); streamd only connects.
Two TCP connections: one blocks on `idle` for change events, one does
request/response commands under a lock. Keeps the state.data["music"] contract
the overlay panels already use.

MPD has no separate "play queue": the queue IS the playlist. Requested songs are
inserted after the current song (in request order) and removed from the queue
once they have played, so they never become part of the regular rotation.
"""
import socket
import subprocess
import threading
import time
from pathlib import Path

from config import (
    log, BASE_DIR, MUSIC_DIR, MPD_HOST, MPD_PORT, MPD_PASSWORD, MPD_PATH,
    MPD_CONF, MPD_AUTOFILL,
)
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic, write_bytes_atomic

ART_EXTS = (".jpg", ".jpeg", ".png", ".webp")
# music videos / lyric videos live next to songs; keep MPD from indexing them
MPDIGNORE = "*.mp4\n*.webm\n*.mkv\n*.mov\n"

_cmd_lock = threading.Lock()
_cmd_conn: "_MpdConn | None" = None
_last_key = None
_request_ids: list[str] = []   # songids of requested tracks, in request order
_reached: set[str] = set()     # requested songids that have started playing
_poll_started = False


class MpdError(Exception):
    pass


def _q(arg) -> str:
    return '"' + str(arg).replace("\\", "\\\\").replace('"', '\\"') + '"'


class _MpdConn:
    def __init__(self, timeout: float | None) -> None:
        self.sock = socket.create_connection((MPD_HOST, MPD_PORT), timeout=timeout)
        self.f = self.sock.makefile("rb")
        greeting = self.f.readline()
        if not greeting.startswith(b"OK MPD"):
            raise ConnectionError(f"unexpected greeting: {greeting!r}")
        if MPD_PASSWORD:
            self.call("password", MPD_PASSWORD)

    def call(self, *args) -> tuple[list[tuple[str, str]], bytes | None]:
        line = str(args[0]) + "".join(" " + _q(a) for a in args[1:])
        self.sock.sendall((line + "\n").encode("utf-8"))
        pairs: list[tuple[str, str]] = []
        binary = None
        while True:
            raw = self.f.readline()
            if not raw:
                raise ConnectionError("mpd closed the connection")
            line = raw.rstrip(b"\n").decode("utf-8", "replace")
            if line == "OK":
                return pairs, binary
            if line.startswith("ACK"):
                raise MpdError(line)
            key, _, value = line.partition(": ")
            if key == "binary":
                binary = self.f.read(int(value))
                self.f.readline()  # newline after the blob
                continue
            pairs.append((key, value))

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def cmd(*args) -> tuple[list[tuple[str, str]], bytes | None]:
    """Run one command on the shared command connection (reconnects once)."""
    global _cmd_conn
    with _cmd_lock:
        for attempt in range(2):
            try:
                if _cmd_conn is None:
                    _cmd_conn = _MpdConn(timeout=10)
                return _cmd_conn.call(*args)
            except MpdError:
                raise
            except Exception:
                if _cmd_conn is not None:
                    _cmd_conn.close()
                _cmd_conn = None
                if attempt:
                    raise
    raise ConnectionError("unreachable")


def _dict(pairs: list[tuple[str, str]]) -> dict:
    out: dict = {}
    for k, v in pairs:
        out.setdefault(k.lower(), v)
    return out


# ── library helpers ─────────────────────────────────────────────────────

def _ensure_mpdignore() -> None:
    path = MUSIC_DIR / ".mpdignore"
    if MUSIC_DIR.exists() and not path.exists():
        try:
            path.write_text(MPDIGNORE, encoding="utf-8")
            log.info("[mpd] wrote %s so sidecar videos aren't indexed", path)
        except OSError as e:
            log.warning("[mpd] could not write .mpdignore: %s", e)


def _to_uri(path: str | Path) -> str | None:
    """MPD addresses songs relative to its music_directory."""
    p = Path(path)
    try:
        return (p.relative_to(MUSIC_DIR) if p.is_absolute() else p).as_posix()
    except ValueError:
        return None


def _wait_db_update(timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if "updating_db" not in _dict(cmd("status")[0]):
            return True
        time.sleep(0.25)
    return False


# ── state mapping ───────────────────────────────────────────────────────

def _set_idle() -> None:
    global _last_key
    _last_key = None
    music = {"title": "—", "artist": "", "playing": False, "duration": 0,
             "position": 0, "video_url": None}
    state.data["music"] = music
    broadcast_sync({"type": "music", **music})


def _read_binary(command: str, uri: str) -> bytes | None:
    buf, offset, total = b"", 0, None
    while total is None or offset < total:
        try:
            pairs, blob = cmd(command, uri, offset)
        except MpdError:
            return None
        if not blob:
            break
        total = int(_dict(pairs).get("size", 0))
        buf += blob
        offset = len(buf)
    return buf or None


def _update_art(uri: str) -> None:
    def _worker() -> None:
        try:
            data = _read_binary("readpicture", uri) or _read_binary("albumart", uri)
            if not data:
                side = next((c for e in ART_EXTS
                             if (c := (MUSIC_DIR / uri).with_suffix(e)).exists()), None)
                data = side.read_bytes() if side else None
            if data:
                write_bytes_atomic(BASE_DIR / "art.png", data)
            else:
                log.info("[mpd] no art for %s", uri)
        except Exception as e:
            log.warning("[mpd] art fetch failed for %s: %s", uri, e)

    threading.Thread(target=_worker, daemon=True, name="mpd-art").start()


def _cleanup_requests(current_id: str | None) -> None:
    if current_id in _request_ids:
        _reached.add(current_id)
    for sid in list(_reached):
        if sid != current_id:
            try:
                cmd("deleteid", sid)
            except MpdError:
                pass  # already gone (e.g. removed from ncmpcpp)
            _reached.discard(sid)
            if sid in _request_ids:
                _request_ids.remove(sid)


def _refresh() -> None:
    global _last_key
    from commands import fetch_and_broadcast_lyrics

    status = _dict(cmd("status")[0])
    song = _dict(cmd("currentsong")[0])
    _cleanup_requests(status.get("songid"))

    uri = song.get("file")
    if status.get("state") == "stop" or not uri:
        _set_idle()
        return

    title = song.get("title") or Path(uri).stem
    artist = song.get("artist", "")
    if not song.get("title") and " - " in title:
        guess_artist, title = title.split(" - ", 1)
        artist = artist or guess_artist

    def _f(value, default=0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    music = {
        "title": title,
        "artist": artist,
        "playing": status.get("state") == "play",
        "duration": _f(status.get("duration") or song.get("duration") or song.get("time")),
        "position": _f(status.get("elapsed")),
        "video_url": state.data.get("music", {}).get("video_url"),
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


# ── threads ─────────────────────────────────────────────────────────────

def _ensure_mpd() -> None:
    try:
        _MpdConn(timeout=2).close()
        return
    except OSError:
        if not MPD_PATH:
            raise
    args = [MPD_PATH, "--no-daemon"] + ([MPD_CONF] if MPD_CONF else [])
    log.info("[mpd] not reachable, spawning: %s", " ".join(args))
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)


def _poll_loop() -> None:
    """idle events fire on state changes, not as time passes; re-sync the
    position now and then so the lyrics panel doesn't drift."""
    while True:
        time.sleep(3)
        try:
            if state.data.get("music", {}).get("playing"):
                _refresh()
        except Exception:
            pass


def run_mpd_thread() -> None:
    global _poll_started
    while True:
        idle = None
        try:
            _ensure_mpd()
            _ensure_mpdignore()
            idle = _MpdConn(timeout=None)
            log.info("[mpd] connected to %s:%s", MPD_HOST, MPD_PORT)
            if MPD_AUTOFILL and not _dict(cmd("status")[0]).get("playlistlength", "0") != "0":
                cmd("add", "/")
                cmd("random", 0)
                cmd("shuffle")
                cmd("repeat", 1)
            if not _poll_started:
                _poll_started = True
                threading.Thread(target=_poll_loop, daemon=True, name="mpd-poll").start()
            while True:
                _refresh()
                idle.call("idle", "player", "playlist", "database", "options")
        except Exception as e:
            log.warning("[mpd] bridge error: %s - retrying in 5s", e)
            _set_idle()
            if idle:
                idle.close()
            time.sleep(5)


# ── public controls ─────────────────────────────────────────────────────

def media_control(action: str) -> None:
    try:
        playing = _dict(cmd("status")[0]).get("state") == "play"
        if action == "play":
            cmd("pause", 0) if _dict(cmd("status")[0]).get("state") == "pause" else cmd("play")
        elif action == "pause":
            cmd("pause", 1)
        elif action == "toggle":
            cmd("pause", 1) if playing else (
                cmd("pause", 0) if _dict(cmd("status")[0]).get("state") == "pause" else cmd("play"))
        elif action == "next":
            cmd("next")
        elif action == "prev":
            cmd("previous")
        else:
            log.warning("[mpd] unknown media action %r", action)
    except Exception as e:
        log.warning("[mpd] media_control %s failed: %s", action, e)


def play_file(path: str | Path, mode: str = "insert-next") -> str | None:
    """Queue a file that lives under the music directory. Returns the songid.
    mode: 'insert-next' (after current + earlier requests), 'append', 'replace'."""
    if mode not in ("insert-next", "append", "replace"):
        raise ValueError(mode)
    uri = _to_uri(path)
    if uri is None:
        log.warning("[mpd] %s is outside the music directory %s", path, MUSIC_DIR)
        return None
    try:
        cmd("update", uri)
        _wait_db_update()
        status = _dict(cmd("status")[0])
        if mode == "insert-next" and "song" in status:
            pending = [s for s in _request_ids if s not in _reached]
            pos = int(status["song"]) + 1 + len(pending)
            songid = _dict(cmd("addid", uri, pos)[0]).get("id")
        else:
            songid = _dict(cmd("addid", uri)[0]).get("id")
        if songid is None:
            return None
        if mode == "insert-next":
            _request_ids.append(songid)
            cmd("prioid", max(1, 255 - len(pending)), songid)
        if mode == "replace" or status.get("state") == "stop":
            cmd("playid", songid)
        return songid
    except Exception as e:
        log.warning("[mpd] play_file failed for %s: %s", path, e)
        return None


def request_song(query: str, user: str) -> tuple[bool, str]:
    # replaced in the requests step (credits + approval + yt-dlp download)
    return False, "song requests now go through the request page"

import random

def _playlist_file(name: str) -> Path:
    return MUSIC_DIR / name / f"{name}.m3u"


def list_playlists() -> list[str]:
    if not MUSIC_DIR.exists():
        return []
    return sorted(d.name for d in MUSIC_DIR.iterdir()
                  if d.is_dir() and _playlist_file(d.name).exists())


def _read_m3u(path: Path) -> list[str]:
    """Return MPD URIs (relative to the music dir) for each entry."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text(encoding="cp1252", errors="replace")
    uris = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entry = Path(line)
        if not entry.is_absolute():
            entry = path.parent / entry
        uri = _to_uri(entry)
        if uri:
            uris.append(uri)
    return uris


def load_playlist(name: str, shuffle: bool = False, skip: bool = False) -> bool:
    """Replace the regular queue with a playlist, keeping the current song and
    pending requests. skip=True jumps to the new playlist immediately."""
    try:
        uris = _read_m3u(_playlist_file(name))
        if shuffle:
            random.shuffle(uris)
        cmd("random", 0)  # random mode would break "insert-next" ordering
        current = _dict(cmd("status")[0]).get("songid")
        keep = set(_request_ids) | ({current} if current else set())
        for key, value in cmd("playlistinfo")[0]:
            if key.lower() == "id" and value not in keep:
                cmd("deleteid", value)
        added = skipped = 0
        for uri in uris:
            try:
                cmd("addid", uri)
                added += 1
            except MpdError:
                skipped += 1  # not in MPD's database (yet) or file missing
        log.info("[mpd] playlist %r: %d added, %d skipped", name, added, skipped)
        state.data["playlist"] = name
        broadcast_sync({"type": "playlist", "name": name})
        if _dict(cmd("status")[0]).get("state") == "stop":
            cmd("play")
        elif skip:
            cmd("next")
        return added > 0
    except Exception as e:
        log.warning("[mpd] load_playlist %r failed: %s", name, e)
        return False