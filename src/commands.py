import json
import random
import re
import threading
import time
import xml.etree.ElementTree as ET

from config import log, COMMANDS_PATH, CHAN
from state import state
from broadcast import broadcast_sync, send_chat
from conditions import check_conditions

_DEFAULT_COMMANDS = {
    "!throw": {
        "type": "builtin",
        "enabled": True,
        "description": "throw an item at the streamer",
    },
    "!shake": {
        "type": "builtin",
        "enabled": True,
        "description": "shake the camera",
    },
    "!lightsoff": {
        "type": "builtin",
        "enabled": True,
        "description": "toggle lights off for 2 minutes",
    },
    "!status": {
        "type": "builtin",
        "enabled": True,
        "description": "show cpu/mem/gpu/wpm/uptime overlay",
    },
    "!lyrics": {
        "type": "builtin",
        "enabled": True,
        "description": "show lyrics for the currently playing song in the status corner",
    },
    "!panel": {
        "type": "builtin",
        "enabled": True,
        "description": "switch the status corner's default panel (socials/status)",
    },
    "!flags": {
        "type": "builtin",
        "enabled": True,
        "description": "show how many flags you have",
    },
}


def load_commands() -> dict:
    if COMMANDS_PATH.exists():
        try:
            commands = json.loads(COMMANDS_PATH.read_text(encoding="utf-8"))
            for trigger, cmd in _DEFAULT_COMMANDS.items():
                commands.setdefault(trigger, cmd)
            return commands
        except Exception:
            pass
    return dict(_DEFAULT_COMMANDS)


def save_commands(commands: dict) -> None:
    try:
        COMMANDS_PATH.write_text(json.dumps(commands, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("failed to save commands: %s", e)


# ── permissions ──────────────────────────────────────────────────────────

_PERM_RANK = {"everyone": 0, "vip": 1, "subscriber": 1, "mod": 2, "moderator": 2, "broadcaster": 3}


def _user_rank(login: str, badges: list) -> int:
    names = {b.get("name") for b in (badges or [])}
    if login.lower() == CHAN.lstrip("#").lower():
        return 3
    if "broadcaster" in names:
        return 3
    if "moderator" in names:
        return 2
    if "vip" in names or "subscriber" in names or "founder" in names:
        return 1
    return 0


def _has_permission(cmd: dict, login: str, badges: list) -> bool:
    required = cmd.get("permission", "everyone")
    return _user_rank(login, badges) >= _PERM_RANK.get(required, 0)


# ── scripting / placeholders ────────────────────────────────────────────

def _check_cooldown(trigger: str, seconds: int) -> bool:
    if seconds <= 0:
        return True
    now = time.monotonic()
    last = state.cooldowns.get(trigger, 0)
    if now - last < seconds:
        return False
    state.cooldowns[trigger] = now
    return True


_RANDOM_RE = re.compile(r"\{random:([^}]*)\}")
_COUNT_RE = re.compile(r"\{count\}")


def _render_response(trigger: str, response: str, user: str, arg: str) -> str:
    stats = state.data.get("stats", {})

    def _random_sub(m: "re.Match") -> str:
        choices = [c for c in m.group(1).split("|") if c]
        return random.choice(choices) if choices else ""

    response = _RANDOM_RE.sub(_random_sub, response)

    if _COUNT_RE.search(response):
        state.counters[trigger] = state.counters.get(trigger, 0) + 1
        response = _COUNT_RE.sub(str(state.counters[trigger]), response)

    response = (
        response
        .replace("{user}", user)
        .replace("{arg}", arg)
        .replace("{cpu}", stats.get("cpu", "…"))
        .replace("{mem}", stats.get("mem", "…"))
        .replace("{gpu}", stats.get("gpu", "…"))
        .replace("{uptime}", stats.get("uptime", "…"))
        .replace("{wpm}", stats.get("wpm", "…"))
    )
    return response


# ── lyrics ───────────────────────────────────────────────────────────────

_LRC_LINE_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)")


def _parse_lrc(lrc_text: str) -> list[dict]:
    """parse standard LRC format → [{time: float_seconds, text: str}]
    sorted by time. empty/instrumental lines are included as empty text
    so the overlay can show a gap."""
    lines = []
    for raw in lrc_text.splitlines():
        m = _LRC_LINE_RE.match(raw.strip())
        if not m:
            continue
        minutes = int(m.group(1))
        seconds = float(m.group(2))
        text = m.group(3).strip()
        lines.append({"time": minutes * 60 + seconds, "text": text})
    lines.sort(key=lambda l: l["time"])
    return lines


def _parse_ttml_words(ttml_text: str) -> list[dict]:
    """parse a TTML document → [{time: float, end: float, word: str}]
    Each <span begin="..." end="...">word</span> within a <p> becomes
    one entry.  Falls back to line-level <p> elements if no span children
    have their own begin/end attributes (some providers use line-level TTML).
    """
    words = []
    try:
        # strip namespace prefixes so ElementTree doesn't choke
        clean = re.sub(r' xmlns[^"]*"[^"]*"', "", ttml_text)
        clean = re.sub(r"<(/?)tt:", r"<\1", clean)
        clean = re.sub(r"<(/?)tts:", r"<\1", clean)
        root = ET.fromstring(clean)
    except ET.ParseError as e:
        log.debug("[lyrics] ttml parse error: %s", e)
        return words

    def _t(attr: str) -> float | None:
        """convert HH:MM:SS.mmm or MM:SS.mmm or plain seconds to float."""
        if not attr:
            return None
        parts = attr.rstrip("s").split(":")
        try:
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
            if len(parts) == 2:
                return int(parts[0]) * 60 + float(parts[1])
            return float(parts[0])
        except (ValueError, IndexError):
            return None

    # walk all <p> and <span> elements
    for p in root.iter("p"):
        p_begin = _t(p.get("begin"))
        p_end   = _t(p.get("end"))
        spans = list(p)
        word_spans = [s for s in spans if s.get("begin") or s.get("end")]
        if word_spans:
            for span in word_spans:
                t = _t(span.get("begin")) or p_begin
                e = _t(span.get("end"))   or p_end
                w = (span.text or "").strip()
                if w and t is not None:
                    words.append({"time": t, "end": e, "word": w})
        elif p_begin is not None:
            # line-level: treat the whole <p> text as one "word" entry
            text = "".join(p.itertext()).strip()
            if text:
                words.append({"time": p_begin, "end": p_end, "word": text})

    words.sort(key=lambda w: w["time"])
    return words


def _fetch_lrclib(artist: str, title: str, duration: float | None = None) -> dict | None:
    """fetch from lrclib.net. returns the JSON dict or None.
    tries /api/get first (exact match) then /api/search as fallback."""
    import urllib.parse
    import urllib.request

    headers = {"User-Agent": "streamd/1.0 (github.com/streamd; contact via twitch)"}

    # primary: exact lookup
    params: dict = {"track_name": title, "artist_name": artist}
    if duration:
        params["duration"] = str(int(duration))
    url = "https://lrclib.net/api/get?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log.debug("[lyrics] lrclib get failed: %s", e)

    # fallback: search
    search_url = "https://lrclib.net/api/search?" + urllib.parse.urlencode(
        {"track_name": title, "artist_name": artist}
    )
    try:
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                results = json.loads(resp.read().decode("utf-8"))
                if results:
                    return results[0]
    except Exception as e:
        log.debug("[lyrics] lrclib search failed: %s", e)

    return None


def _fetch_lrcmux(artist: str, title: str) -> dict | None:
    """fetch word-synced lyrics from lrcmux.dev.
    returns {lrc: str|None, ttml: str|None} or None on failure."""
    import urllib.parse
    import urllib.request

    headers = {"User-Agent": "streamd/1.0"}
    search_url = "https://lrcmux.dev/api/lyrics/search?" + urllib.parse.urlencode(
        {"track": title, "artist": artist}
    )
    try:
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            if resp.status != 200:
                return None
            results = json.loads(resp.read().decode("utf-8"))
        # prefer word-synced results
        candidates = results.get("results", []) if isinstance(results, dict) else results
        if not candidates:
            return None
        # pick first with word sync, fall back to first with line sync, then any
        best = None
        for c in candidates:
            if c.get("hasWordSync"):
                best = c
                break
        if not best:
            for c in candidates:
                if c.get("hasLineSync"):
                    best = c
                    break
        if not best:
            best = candidates[0]

        lyric_id = best.get("id")
        if not lyric_id:
            return None

        fetch_url = f"https://lrcmux.dev/api/lyrics/{lyric_id}"
        req2 = urllib.request.Request(fetch_url, headers=headers)
        with urllib.request.urlopen(req2, timeout=8) as resp2:
            if resp2.status != 200:
                return None
            return json.loads(resp2.read().decode("utf-8"))
    except Exception as e:
        log.debug("[lyrics] lrcmux failed: %s", e)
        return None


def _fetch_lyrics_full(artist: str, title: str, duration: float | None = None) -> dict:
    """main lyrics fetch. returns a dict ready to broadcast as a lyrics event:
    {
        found: bool,
        title, artist,
        plain_lines: [str],          # plain text, one line each
        synced_lines: [{time, text}], # LRC-parsed, empty if unavailable
        synced_words: [{time, end, word}], # TTML-parsed, empty if unavailable
        reason: str                  # only present when found=False
    }
    """
    payload: dict = {
        "found": False,
        "title": title,
        "artist": artist,
        "plain_lines": [],
        "synced_lines": [],
        "synced_words": [],
    }

    # --- try lrcmux first for word-level sync ---
    lrcmux_data = _fetch_lrcmux(artist, title)
    if lrcmux_data:
        ttml_text = lrcmux_data.get("ttml") or ""
        lrc_text  = lrcmux_data.get("lrc") or ""
        if ttml_text:
            words = _parse_ttml_words(ttml_text)
            if words:
                payload["synced_words"] = words
                payload["found"] = True
                log.info("[lyrics] got word-synced lyrics from lrcmux for %s - %s", artist, title)
        if lrc_text and not payload["synced_lines"]:
            lines = _parse_lrc(lrc_text)
            if lines:
                payload["synced_lines"] = lines
                payload["plain_lines"] = [l["text"] for l in lines if l["text"]]
                payload["found"] = True

    # --- fall back / supplement with lrclib ---
    lrclib_data = _fetch_lrclib(artist, title, duration)
    if lrclib_data:
        synced_lrc = lrclib_data.get("syncedLyrics") or ""
        plain_txt  = lrclib_data.get("plainLyrics") or ""

        if synced_lrc and not payload["synced_lines"]:
            lines = _parse_lrc(synced_lrc)
            if lines:
                payload["synced_lines"] = lines
                payload["plain_lines"] = [l["text"] for l in lines if l["text"]]
                payload["found"] = True
                log.info("[lyrics] got line-synced lyrics from lrclib for %s - %s", artist, title)

        if plain_txt and not payload["plain_lines"]:
            cleaned = [l.rstrip() for l in plain_txt.splitlines()]
            # strip leading/trailing blank lines
            while cleaned and not cleaned[0]:
                cleaned.pop(0)
            while cleaned and not cleaned[-1]:
                cleaned.pop()
            if cleaned:
                payload["plain_lines"] = cleaned
                payload["found"] = True
                log.info("[lyrics] got plain lyrics from lrclib for %s - %s", artist, title)

    if not payload["found"]:
        payload["reason"] = "couldn't find lyrics for this one"
        log.info("[lyrics] no lyrics found for %s - %s", artist, title)

    return payload


def fetch_and_broadcast_lyrics(artist: str, title: str, user: str | None = None) -> None:
    """fetches lyrics in a background thread and broadcasts a `lyrics` event."""
    music = state.data.get("music", {})
    duration = music.get("duration") or None

    def _worker() -> None:
        result = _fetch_lyrics_full(artist, title, duration)
        payload = {"type": "lyrics", **result}
        if user is not None:
            payload["user"] = user
        broadcast_sync(payload)

    threading.Thread(target=_worker, daemon=True, name="lyrics-fetch").start()


def handle_lyrics_command(user: str) -> None:
    music = state.data.get("music", {})
    title = music.get("title", "")
    artist = music.get("artist", "")
    if not title or title == "—":
        broadcast_sync({"type": "lyrics", "user": user, "found": False,
                         "reason": "nothing playing right now",
                         "plain_lines": [], "synced_lines": [], "synced_words": []})
        return
    fetch_and_broadcast_lyrics(artist, title, user=user)


def dispatch_chat_command(user: str, text: str, badges: list | None = None) -> None:
    if not text.startswith("!"):
        return
    parts = text.strip().split(None, 1)
    trigger = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""

    commands = state.data.get("commands", {})
    cmd = commands.get(trigger)
    if cmd is None or not cmd.get("enabled", True):
        return

    if not _has_permission(cmd, user, badges or []):
        return

    if not check_conditions(cmd, user, badges or []):
        return

    if not _check_cooldown(trigger, cmd.get("cooldown", 0)):
        return

    ctype = cmd.get("type", "custom")

    if ctype == "builtin":
        if trigger == "!throw":
            broadcast_sync({"type": "throw", "item": arg, "user": user})
        elif trigger == "!shake":
            broadcast_sync({"type": "shake", "user": user})
        elif trigger == "!lightsoff":
            broadcast_sync({"type": "lightsoff", "user": user})
        elif trigger == "!status":
            broadcast_sync({"type": "stats", **state.data.get("stats", {})})
            broadcast_sync({"type": "show_stats"})
        elif trigger == "!lyrics":
            handle_lyrics_command(user)
        elif trigger == "!panel":
            panel = arg.strip().lower() or "socials"
            if panel in ("status", "pc", "pcstatus"):
                panel = "status"
            else:
                panel = "socials"
            broadcast_sync({"type": "panel", "panel": panel})
        elif trigger == "!flags":
            from flags import get_flags
            count = get_flags(user)
            send_chat(f"{user} has {count} flag(s)!")
    elif ctype == "custom":
        response = cmd.get("response", "")
        if response:
            response = _render_response(trigger, response, user, arg)
            send_chat(response)
            broadcast_sync({"type": "bot_say", "text": response})