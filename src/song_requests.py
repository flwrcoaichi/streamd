"""Song credits, YouTube search, and request downloads for the music player."""
import html
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from config import log, BASE_DIR, MUSIC_DIR, YOUTUBE_API_KEY, SONG_MAX_SECONDS, SONG_MAX_PENDING
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic

CREDITS_PATH = BASE_DIR / "song_credits.json"
CACHE_PATH = BASE_DIR / "song_cache.json"      # video id -> uri relative to MUSIC_DIR
REQUEST_DIR = MUSIC_DIR / "Requests"
ACTIVE = ("downloading", "queued", "playing")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_dl_lock = threading.Lock()
_cache_lock = threading.Lock()
_next_id = 0
_search_cache: dict[str, tuple[float, list]] = {}


# ── credits ─────────────────────────────────────────────────────────────

def load_song_credits() -> None:
    try:
        data = json.loads(CREDITS_PATH.read_text(encoding="utf-8"))
        state.song_credits.update({str(k): int(v) for k, v in data.items()})
    except Exception:
        pass


def get_song_credits(user: str) -> int:
    return state.song_credits.get((user or "").lower(), 0)


def add_song_credits(user: str, amount: int) -> int:
    key = (user or "").strip().lower()
    with state.song_lock:
        total = max(0, state.song_credits.get(key, 0) + int(amount))
        state.song_credits[key] = total
        write_atomic(CREDITS_PATH, json.dumps(state.song_credits, indent=2))
    broadcast_sync({"type": "song_credits", "user": key, "credits": total})
    return total


def _spend(user: str) -> bool:
    key = user.lower()
    with state.song_lock:
        if state.song_credits.get(key, 0) <= 0:
            return False
        state.song_credits[key] -= 1
        write_atomic(CREDITS_PATH, json.dumps(state.song_credits, indent=2))
    broadcast_sync({"type": "song_credits", "user": key, "credits": state.song_credits[key]})
    return True


# ── parsing + search ────────────────────────────────────────────────────

def parse_video_id(text: str) -> str | None:
    text = (text or "").strip()
    if _ID_RE.match(text):
        return text
    try:
        u = urllib.parse.urlparse(text if "://" in text else "https://" + text)
    except ValueError:
        return None
    host = (u.hostname or "").lower().removeprefix("www.")
    cand = ""
    if host == "youtu.be":
        cand = u.path.lstrip("/")[:11]
    elif host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        q = urllib.parse.parse_qs(u.query)
        if "v" in q:
            cand = q["v"][0]
        else:
            m = re.match(r"^/(?:shorts|embed|live)/([\w-]{11})", u.path)
            cand = m.group(1) if m else ""
    return cand if _ID_RE.match(cand) else None


def _search_api(q: str) -> list[dict]:
    url = "https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode({
        "part": "snippet", "type": "video", "maxResults": 8, "q": q, "key": YOUTUBE_API_KEY,
    })
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 403:
            raise RuntimeError("search quota reached for today, paste a link instead") from e
        raise RuntimeError(f"youtube search failed ({e.code})") from e
    out = []
    for item in data.get("items", []):
        vid = (item.get("id") or {}).get("videoId")
        sn = item.get("snippet") or {}
        if vid:
            out.append({
                "video_id": vid,
                "title": html.unescape(sn.get("title", "")),
                "channel": html.unescape(sn.get("channelTitle", "")),
                "thumbnail": ((sn.get("thumbnails") or {}).get("medium") or {}).get("url", ""),
            })
    return out


def _search_ytdlp(q: str) -> list[dict]:
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch8:{q}", download=False)
    return [{
        "video_id": e["id"], "title": e.get("title", ""),
        "channel": e.get("uploader") or e.get("channel") or "",
        "thumbnail": f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg",
    } for e in (info or {}).get("entries", []) if e.get("id")]


def search_youtube(query: str) -> list[dict]:
    """official API when YOUTUBE_API_KEY is set (100 quota units per search, so
    ~100 uncached searches/day on the free 10k quota), yt-dlp search otherwise."""
    q = " ".join(query.split())[:100]
    hit = _search_cache.get(q.lower())
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    results = _search_api(q) if YOUTUBE_API_KEY else _search_ytdlp(q)
    _search_cache[q.lower()] = (time.time(), results)
    return results


# ── request state ───────────────────────────────────────────────────────

def _publish() -> None:
    broadcast_sync({"type": "requests_state", "requests": state.data["requests"]})


def mark_request(songid: str, status: str) -> None:
    for r in state.data["requests"]:
        if r.get("songid") == songid and r["status"] != status:
            r["status"] = status
            _publish()


def _new_entry(user: str, video_id: str) -> dict:
    global _next_id
    _next_id += 1
    entry = {"id": _next_id, "user": user.lower(), "video_id": video_id, "title": video_id,
             "status": "downloading", "error": "", "songid": None, "ts": time.time()}
    reqs = state.data["requests"]
    reqs.append(entry)
    reqs[:] = [r for r in reqs if r["status"] in ACTIVE or time.time() - r["ts"] < 600][-30:]
    return entry


# ── download ────────────────────────────────────────────────────────────

def _load_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _cached_uri(video_id: str) -> str | None:
    uri = _load_cache().get(video_id)
    return uri if uri and (MUSIC_DIR / uri).exists() else None


def _remember(video_id: str, uri: str) -> None:
    with _cache_lock:
        cache = _load_cache()
        cache[video_id] = uri
        write_atomic(CACHE_PATH, json.dumps(cache, indent=2))


def _safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")[:120] or "request"


def _download(video_id: str) -> tuple[str, str]:
    """returns (uri relative to MUSIC_DIR, display title)."""
    try:
        import yt_dlp
    except ImportError as e:
        raise RuntimeError("yt-dlp is not installed") from e

    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("is_live"):
        raise ValueError("live streams can't be requested")
    dur = int(info.get("duration") or 0)
    if SONG_MAX_SECONDS and dur > SONG_MAX_SECONDS:
        raise ValueError(f"too long ({dur // 60}m, max {SONG_MAX_SECONDS // 60}m)")

    artist = info.get("artist") or ((info.get("artists") or [""])[0]) or \
        re.sub(r"\s*-\s*Topic$", "", info.get("uploader") or info.get("channel") or "")
    title = info.get("track") or info.get("title") or video_id
    if info.get("track") and artist:
        name = f"{artist} - {title}"
    elif " - " in title or not artist:
        name = title
    else:
        name = f"{artist} - {title}"
    name = _safe(name)

    REQUEST_DIR.mkdir(parents=True, exist_ok=True)
    base = REQUEST_DIR / name
    if (REQUEST_DIR / (name + ".opus")).exists():       # same name, different video
        base = REQUEST_DIR / f"{name} [{video_id}]"
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(base) + ".%(ext)s",
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "writethumbnail": True,                           # becomes <name>.jpg = album art sidecar
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "opus"},
            {"key": "FFmpegMetadata"},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
        ],
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    final = base.parent / (base.name + ".opus")
    if not final.exists():
        raise FileNotFoundError("download finished but no audio file was produced")
    uri = final.relative_to(MUSIC_DIR).as_posix()
    _remember(video_id, uri)
    return uri, f"{artist} - {title}" if artist and not title.startswith(artist) else title


def _process(entry: dict, unlimited: bool) -> None:
    from player_bridge import play_file
    try:
        uri = _cached_uri(entry["video_id"])
        if uri:
            entry["title"] = MUSIC_DIR.joinpath(uri).stem
        else:
            with _dl_lock:                                # one download at a time
                uri, entry["title"] = _download(entry["video_id"])
        _publish()
        songid = play_file(MUSIC_DIR / uri, "insert-next")
        if songid is None:
            raise RuntimeError("mpd could not queue the file")
        entry["songid"] = songid
        entry["status"] = "queued"
    except Exception as e:
        log.warning("[requests] %s failed: %s", entry["video_id"], e)
        entry["status"] = "failed"
        entry["error"] = str(e)[:200]
        if not unlimited:
            add_song_credits(entry["user"], 1)            # refund
    _publish()


def submit_request(user: str, raw: str) -> tuple[bool, str]:
    from canvas import is_unlimited
    vid = parse_video_id(raw)
    if not vid:
        return False, "that doesn't look like a youtube link"
    key = user.lower()
    unlimited = is_unlimited(key)
    with state.song_lock:
        mine = [r for r in state.data["requests"] if r["user"] == key and r["status"] in ACTIVE]
        if len(mine) >= SONG_MAX_PENDING and not unlimited:
            return False, f"you already have {len(mine)} requests in the queue"
        if any(r["video_id"] == vid and r["status"] in ACTIVE for r in state.data["requests"]):
            return False, "that song is already in the queue"
    if not unlimited and not _spend(key):
        return False, "you have no song credits, redeem some on stream"
    entry = _new_entry(key, vid)
    _publish()
    threading.Thread(target=_process, args=(entry, unlimited), daemon=True, name="song-request").start()
    return True, "request added, it will play next once it's downloaded"