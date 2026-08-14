import json
import random
import re
import threading
import time

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

def _fetch_lyrics(artist: str, title: str) -> str | None:
    """lyrics.ovh — free, no api key required. best-effort: returns None on
    any failure (song not found, network issue, etc) rather than raising."""
    import urllib.parse
    import urllib.request

    if not artist or not title:
        return None
    try:
        url = (
            "https://api.lyrics.ovh/v1/"
            + urllib.parse.quote(artist)
            + "/"
            + urllib.parse.quote(title)
        )
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        lyrics = (data.get("lyrics") or "").strip()
        return lyrics or None
    except Exception as e:
        log.info("[lyrics] fetch failed for %s - %s: %s", artist, title, e)
        return None


def fetch_and_broadcast_lyrics(artist: str, title: str, user: str | None = None) -> None:
    """fetches lyrics in a background thread and broadcasts a `lyrics` event.
    used both for the manual !lyrics command and automatically on track change."""

    def _worker() -> None:
        lyrics = _fetch_lyrics(artist, title)
        payload = {"type": "lyrics"}
        if user is not None:
            payload["user"] = user
        if lyrics:
            lines = [line.rstrip() for line in lyrics.splitlines()]
            while lines and not lines[0].strip():
                lines.pop(0)
            while lines and not lines[-1].strip():
                lines.pop()
            payload.update({"found": True, "title": title, "artist": artist, "lines": lines})
        else:
            payload.update({"found": False, "reason": "couldn't find lyrics for this one"})
        broadcast_sync(payload)

    threading.Thread(target=_worker, daemon=True, name="lyrics-fetch").start()


def handle_lyrics_command(user: str) -> None:
    music = state.data.get("music", {})
    title = music.get("title", "")
    artist = music.get("artist", "")
    if not title or title == "—":
        broadcast_sync({"type": "lyrics", "user": user, "found": False,
                         "reason": "nothing playing right now"})
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
