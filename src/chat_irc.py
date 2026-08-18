import socket
import time

from config import log, PASS, NICK, CHAN, MAX_CHAT_LINES, STATS_INTERVAL
from state import state
from broadcast import broadcast_sync
from helpers import get_cpu, get_mem, get_gpu, get_uptime, get_wpm

# NOTE: WinRT/SMTC-based media tracking (run_music_thread) and its
# media_control() have been removed — playback state and transport
# control now live in ytmusic_bridge.py, backed by pear-desktop's
# companion API instead of the OS media session. See ytmusic_bridge.py.


def run_stats_thread() -> None:
    while True:
        try:
            stats = {
                "cpu": get_cpu(),
                "mem": get_mem(),
                "gpu": get_gpu(),
                "wpm": get_wpm(),
                "uptime": get_uptime(),
            }
            state.data["stats"] = stats
            broadcast_sync({"type": "stats", **stats})
        except Exception as e:
            log.error("[stats] %s", e)
        time.sleep(STATS_INTERVAL)


def _parse_irc_tags(line: str) -> dict:
    if not line.startswith("@"):
        return {}
    raw = line[1:].split(" ", 1)[0]
    tags = {}
    for pair in raw.split(";"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            tags[k] = v
    return tags


def _handle_usernotice(line: str) -> None:
    tags = _parse_irc_tags(line)
    msg_id = tags.get("msg-id", "")
    if msg_id == "raid":
        user = tags.get("msg-param-displayName") or tags.get("msg-param-login", "someone")
        viewers = tags.get("msg-param-viewerCount", "0")
        broadcast_sync({"type": "raid", "user": user, "viewers": viewers})
        log.info("raid from %s (%s viewers)", user, viewers)


_BADGE_ICON_URLS = {
    "broadcaster": "https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1",
    "moderator": "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1",
    "vip": "https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/1",
    "subscriber": "https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/1",
    "founder": "https://static-cdn.jtvnw.net/badges/v1/511b78a9-ab37-472f-9569-457753bbe7d3/1",
    "staff": "https://static-cdn.jtvnw.net/badges/v1/d97c37bd-a6f5-4c38-8f57-4e4bef88af34/1",
    "partner": "https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/1",
    "turbo": "https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/1",
    "premium": "https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/1",
}


def _parse_badges(raw: str) -> list:
    if not raw:
        return []
    out = []
    for entry in raw.split(","):
        if "/" not in entry:
            continue
        name, _, _version = entry.partition("/")
        url = _BADGE_ICON_URLS.get(name)
        if url:
            out.append({"name": name, "url": url})
    return out


def _parse_emotes(raw: str, text: str) -> list:
    if not raw:
        return []
    text_utf16 = text.encode("utf-16-le")
    out = []
    for group in raw.split("/"):
        if ":" not in group:
            continue
        emote_id, ranges = group.split(":", 1)
        for r in ranges.split(","):
            if "-" not in r:
                continue
            start_s, end_s = r.split("-", 1)
            try:
                start, end = int(start_s), int(end_s)
                name = text_utf16[start * 2: (end + 1) * 2].decode("utf-16-le")
            except Exception:
                continue
            out.append({
                "id": emote_id,
                "name": name,
                "start": start,
                "end": end,
                "url": f"https://static-cdn.jtvnw.net/emoticons/v2/{emote_id}/default/dark/1.0",
            })
    return out


def run_chat_thread() -> None:
    from commands import dispatch_chat_command

    chat_buffer: list = []
    while True:
        try:
            s = socket.socket()
            s.connect(("irc.chat.twitch.tv", 6667))
            s.send(b"CAP REQ :twitch.tv/tags twitch.tv/commands\r\n")
            s.send(f"PASS {PASS}\r\n".encode())
            s.send(f"NICK {NICK}\r\n".encode())
            s.send(f"JOIN {CHAN}\r\n".encode())
            state.irc_socket = s
            log.info("irc connected to %s", CHAN)
            buf = ""

            while True:
                chunk = s.recv(2048).decode("utf-8", errors="replace")
                if not chunk:
                    break
                buf += chunk
                while "\r\n" in buf:
                    line, buf = buf.split("\r\n", 1)
                    if line.startswith("PING"):
                        s.send("PONG :tmi.twitch.tv\r\n".encode())
                    elif "USERNOTICE" in line:
                        _handle_usernotice(line)
                    elif "PRIVMSG" in line:
                        tags = _parse_irc_tags(line)
                        rest = line.split(" ", 1)[1] if line.startswith("@") else line
                        parts = rest.split("!", 1)
                        if len(parts) > 1:
                            login = parts[0][1:]
                            msg_parts = rest.split("PRIVMSG", 1)[1].split(":", 1)
                            if len(msg_parts) > 1:
                                text = msg_parts[1].strip()
                                user = tags.get("display-name") or login
                                color = tags.get("color") or ""
                                badges = _parse_badges(tags.get("badges", ""))
                                emotes = _parse_emotes(tags.get("emotes", ""), text)
                                entry = {
                                    "user": user, "text": text,
                                    "color": color, "badges": badges, "emotes": emotes,
                                }
                                chat_buffer.append(entry)
                                if len(chat_buffer) > MAX_CHAT_LINES:
                                    chat_buffer.pop(0)
                                state.data["chat"] = list(chat_buffer)
                                broadcast_sync({"type": "chat", **entry})
                                dispatch_chat_command(login, text, badges)
        except Exception as e:
            log.warning("[chat] %s — reconnecting in 5s", e)
            time.sleep(5)


def run_wpm_tracker() -> None:
    try:
        from pynput import keyboard

        def on_press(key):
            with state.wpm_lock:
                state.keypress_times.append(time.monotonic())

        with keyboard.Listener(on_press=on_press) as listener:
            log.info("[wpm] keyboard listener active")
            listener.join()
    except ImportError:
        log.info("[wpm] pynput not installed — wpm tracking disabled")
    except Exception as e:
        log.warning("[wpm] %s", e)
