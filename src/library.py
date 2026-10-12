"""
library.py - conventions for files that live next to a song in the music dir.

For a song  ~/Music/Artist - Title.opus  the sidecars share its name:

    Artist - Title.mp4          music video   (shown in now playing)
    Artist - Title.lyrics.mp4   lyric video   (shown in the lyrics window)
    Artist - Title.lrc          line-synced lyrics
    Artist - Title.ttml         word-synced lyrics (optional, used together with .lrc)

Replace any of them by dropping a new file with the same name; if several video
extensions exist the most recently modified one wins.
"""
import json
import threading
import time
import urllib.parse
from pathlib import Path

from config import log, BASE_DIR, MUSIC_DIR, MV_DOWNLOAD_ENABLED
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic

VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov")
MISS_PATH = BASE_DIR / "mv_misses.json"

_inflight: set[str] = set()
_inflight_lock = threading.Lock()
_misses: dict[str, float] = {}


def _load_misses() -> None:
    try:
        _misses.update(json.loads(MISS_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass


_load_misses()


def media_url(path: Path) -> str:
    return "/music-media/" + urllib.parse.quote(path.relative_to(MUSIC_DIR).as_posix())


def _newest(candidates: list[Path]) -> Path | None:
    existing = [p for p in candidates if p.exists()]
    return max(existing, key=lambda p: p.stat().st_mtime) if existing else None


def _base(uri: str) -> str:
    song = MUSIC_DIR / uri
    return str(song.with_name(song.stem))  # no extension; safe for names containing dots


def find_sidecars(uri: str) -> dict:
    base = _base(uri)
    video = _newest([Path(base + ext) for ext in VIDEO_EXTS])
    lyric_video = _newest([Path(f"{base}.lyrics{ext}") for ext in VIDEO_EXTS])
    lrc, ttml = Path(base + ".lrc"), Path(base + ".ttml")
    return {
        "video_url": media_url(video) if video else None,
        "lyric_video_url": media_url(lyric_video) if lyric_video else None,
        "lrc": lrc if lrc.exists() else None,
        "ttml": ttml if ttml.exists() else None,
    }


# ── automatic music video search ────────────────────────────────────────

def _find_real_video(title: str, artist: str) -> str | None:
    """Search YouTube for an actual music video, skipping auto-generated
    '<Artist> - Topic' uploads (static album art). Returns a video id or None."""
    try:
        import yt_dlp
    except ImportError:
        return None
    queries = [
        f"ytsearch5:{artist} {title} official music video",
        f"ytsearch5:{artist} {title} official video",
        f"ytsearch5:{artist} {title} official visualizer",
    ]
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        for q in queries:
            try:
                info = ydl.extract_info(q, download=False)
            except Exception as e:
                log.debug("[library] search failed for %r: %s", q, e)
                continue
            for entry in (info or {}).get("entries", []) or []:
                uploader = entry.get("uploader") or entry.get("channel") or ""
                if uploader.strip().endswith("- Topic"):
                    continue
                if entry.get("id"):
                    log.info("[library] video for %r - %r: %s (%s)", artist, title, entry["id"], uploader)
                    return entry["id"]
    return None


def _download_video(video_id: str, uri: str) -> bool:
    import yt_dlp
    opts = {
        # the overlay plays it muted (audio comes from MPD), so video-only is enough
        "format": "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]",
        "outtmpl": _base(uri) + ".%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    return find_sidecars(uri)["video_url"] is not None


def _publish_video(uri: str) -> None:
    music = state.data.get("music", {})
    if music.get("uri") == uri:
        url = find_sidecars(uri)["video_url"]
        music["video_url"] = url
        broadcast_sync({"type": "music_video", "url": url})


def ensure_music_video(uri: str, title: str, artist: str) -> None:
    """If the song has no music video next to it, look for one in the background."""
    if not MV_DOWNLOAD_ENABLED or find_sidecars(uri)["video_url"] or uri in _misses:
        return
    with _inflight_lock:
        if uri in _inflight:
            return
        _inflight.add(uri)

    def _worker() -> None:
        try:
            video_id = _find_real_video(title, artist)
            if video_id and _download_video(video_id, uri):
                _publish_video(uri)
            else:
                _misses[uri] = time.time()
                write_atomic(MISS_PATH, json.dumps(_misses, indent=2))
                log.info("[library] no music video found for %r - %r", artist, title)
        except Exception as e:
            log.info("[library] video download failed for %r - %r: %s", artist, title, e)
        finally:
            with _inflight_lock:
                _inflight.discard(uri)

    threading.Thread(target=_worker, daemon=True, name="mv-find").start()
