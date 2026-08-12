import asyncio
import calendar
import json
import re
import threading
import time
import traceback

import websockets

from config import (
    log, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_BROADCASTER, TWITCH_STATS_INTERVAL,
    AD_REMINDER_WARN_SECONDS, AD_SCHEDULE_POLL_INTERVAL, AD_REMINDER_WARN_MESSAGE,
    AD_REMINDER_START_MESSAGE, AD_REMINDER_END_MESSAGE,
)
from state import state
from broadcast import broadcast_sync, send_chat
from twitch_auth import get_twitch_user_token

_twitch_user_id = None  # kept local like the original (module-level, not per-instance in original either... but original used a module global)


def _helix_headers() -> dict:
    if not state.twitch_app_token:
        state.twitch_app_token = _fetch_twitch_app_token()
    return {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": f"Bearer {state.twitch_app_token}",
    }


def _helix_user_headers() -> dict:
    return {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": f"Bearer {get_twitch_user_token()}",
    }


def _fetch_twitch_app_token() -> str:
    import urllib.parse
    import urllib.request

    body = urllib.parse.urlencode({
        "client_id": TWITCH_CLIENT_ID,
        "client_secret": TWITCH_CLIENT_SECRET,
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=body, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["access_token"]


def _helix_get_user(url: str, params: dict | None = None) -> dict:
    import urllib.parse
    import urllib.request

    full_url = url + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(full_url, headers=_helix_user_headers())
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _helix_get(url: str, params: dict | None = None) -> dict:
    import urllib.error
    import urllib.parse
    import urllib.request

    full_url = url + ("?" + urllib.parse.urlencode(params) if params else "")

    def _do() -> dict:
        req = urllib.request.Request(full_url, headers=_helix_headers())
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        return _do()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            state.twitch_app_token = ""
            return _do()
        raise


def resolve_twitch_user_id() -> str | None:
    global _twitch_user_id
    if _twitch_user_id:
        return _twitch_user_id
    if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
        return None
    try:
        data = _helix_get("https://api.twitch.tv/helix/users", {"login": TWITCH_BROADCASTER})
        users = data.get("data", [])
        if users:
            _twitch_user_id = users[0]["id"]
            return _twitch_user_id
    except Exception as e:
        log.warning("[twitch] failed to resolve user id: %s", e)
    return None


# ── channel info (title / category / tags) ─────────────────────────────────

FIRST_TITLE_SUFFIX_RE = re.compile(r"\s*\|\s*first:\s*.+$", re.IGNORECASE)


def _helix_patch_channel(broadcaster_id: str, payload: dict) -> None:
    import urllib.request

    req = urllib.request.Request(
        f"https://api.twitch.tv/helix/channels?broadcaster_id={broadcaster_id}",
        data=json.dumps(payload).encode("utf-8"),
        headers={**_helix_user_headers(), "Content-Type": "application/json"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def _search_twitch_category(name: str) -> dict | None:
    try:
        data = _helix_get("https://api.twitch.tv/helix/search/categories", {"query": name, "first": 10})
    except Exception as e:
        log.warning("[twitch] category search failed for %r: %s", name, e)
        return None
    results = data.get("data", [])
    if not results:
        return None
    for r in results:
        if r.get("name", "").lower() == name.lower():
            return r
    return results[0]


def set_channel_title(title: str, remember_as_base: bool = True) -> bool:
    uid = resolve_twitch_user_id()
    if not uid:
        log.warning("[twitch] can't set title, broadcaster id not resolved")
        return False
    try:
        _helix_patch_channel(uid, {"title": title})
    except Exception as e:
        log.warning("[twitch] failed to set title: %s", e)
        return False
    if remember_as_base:
        state.base_stream_title = title
    state.data["twitch"]["title"] = title
    broadcast_sync({"type": "twitch_stats", "twitch": state.data["twitch"]})
    return True


def set_channel_category(name: str) -> bool:
    uid = resolve_twitch_user_id()
    if not uid:
        log.warning("[twitch] can't set category, broadcaster id not resolved")
        return False
    match = _search_twitch_category(name)
    if not match:
        log.warning("[twitch] no category found matching %r", name)
        return False
    try:
        _helix_patch_channel(uid, {"game_id": match["id"]})
    except Exception as e:
        log.warning("[twitch] failed to set category: %s", e)
        return False
    state.data["twitch"]["game_id"] = match["id"]
    state.data["twitch"]["game_name"] = match["name"]
    broadcast_sync({"type": "twitch_stats", "twitch": state.data["twitch"]})
    return True


def set_channel_tags(tags: list[str]) -> bool:
    uid = resolve_twitch_user_id()
    if not uid:
        log.warning("[twitch] can't set tags, broadcaster id not resolved")
        return False
    tags = [t.strip() for t in tags if t.strip()][:10]
    try:
        _helix_patch_channel(uid, {"tags": tags})
    except Exception as e:
        log.warning("[twitch] failed to set tags: %s", e)
        return False
    state.data["twitch"]["tags"] = tags
    broadcast_sync({"type": "twitch_stats", "twitch": state.data["twitch"]})
    return True


def add_channel_tag(tag: str) -> bool:
    current = list(state.data["twitch"].get("tags", []))
    if tag in current:
        return True
    if len(current) >= 10:
        log.info("[twitch] tag list already at the 10-tag cap, not adding %r", tag)
        return False
    return set_channel_tags(current + [tag])


def _get_live_channel_title(uid: str) -> str:
    try:
        data = _helix_get("https://api.twitch.tv/helix/channels", {"broadcaster_id": uid})
        channels = data.get("data", [])
        if channels:
            return channels[0].get("title", "")
    except Exception as e:
        log.warning("[twitch] failed to fetch current title: %s", e)
    return state.data["twitch"].get("title", "")


def apply_first_chatter_title_suffix(user: str) -> None:
    with state.channel_info_lock:
        base = state.base_stream_title
        if base is None:
            uid = resolve_twitch_user_id()
            live_title = _get_live_channel_title(uid) if uid else state.data["twitch"].get("title", "")
            base = FIRST_TITLE_SUFFIX_RE.sub("", live_title)
        new_title = f"{base} | first: {user}"
        if set_channel_title(new_title, remember_as_base=False):
            state.base_stream_title = base


def reset_first_chatter_title_suffix() -> None:
    with state.channel_info_lock:
        if state.base_stream_title is not None:
            set_channel_title(state.base_stream_title, remember_as_base=True)
        state.base_stream_title = None


def _resolve_twitch_bot_user_id() -> str | None:
    if state.twitch_authorizing_user_id:
        return state.twitch_authorizing_user_id
    try:
        data = _helix_get_user("https://api.twitch.tv/helix/users")
        users = data.get("data", [])
        if users:
            state.twitch_authorizing_user_id = users[0]["id"]
            return state.twitch_authorizing_user_id
    except Exception as e:
        log.warning("[twitch] failed to resolve authorizing user id: %s", e)
    return None


def run_twitch_stats_thread() -> None:
    if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
        log.info("[twitch] TWITCH_CLIENT_ID not set, stats polling disabled")
        return

    was_live = False

    while True:
        try:
            uid = resolve_twitch_user_id()
            if not uid:
                time.sleep(TWITCH_STATS_INTERVAL)
                continue

            followers = None
            try:
                followers = _helix_get_user(
                    "https://api.twitch.tv/helix/channels/followers",
                    {"broadcaster_id": uid, "first": 1},
                ).get("total")
            except Exception as e:
                log.warning("[twitch] followers count failed (needs moderator:read:followers on cocoFLWR's token): %s", e)

            subs = None
            try:
                subs = _helix_get(
                    "https://api.twitch.tv/helix/subscriptions",
                    {"broadcaster_id": uid, "first": 1},
                ).get("total")
            except Exception:
                pass

            streams = _helix_get("https://api.twitch.tv/helix/streams", {"user_id": uid}).get("data", [])
            live = bool(streams)
            viewers = streams[0].get("viewer_count") if streams else None
            title = streams[0].get("title", "") if streams else state.data["twitch"].get("title", "")
            game_id = streams[0].get("game_id", "") if streams else ""
            game_name = streams[0].get("game_name", "") if streams else ""
            tags = streams[0].get("tags", []) if streams else []

            twitch = state.data["twitch"]
            twitch.update({
                "connected": True,
                "followers": followers,
                "subscribers": subs,
                "viewers": viewers,
                "live": live,
                "title": title,
                "game_id": game_id,
                "game_name": game_name,
                "tags": tags,
            })
            broadcast_sync({"type": "twitch_stats", "twitch": twitch})

            if was_live and not live:
                reset_first_chatter_title_suffix()
            was_live = live
        except Exception as e:
            log.warning("[twitch] stats poll failed: %s", e)
            state.data["twitch"]["connected"] = False
            broadcast_sync({"type": "twitch_stats", "twitch": state.data["twitch"]})

        time.sleep(TWITCH_STATS_INTERVAL)


async def _twitch_eventsub_subscribe(session_id: str, sub_type: str, version: str, condition: dict, use_user_token: bool = False) -> None:
    import urllib.error
    import urllib.request

    def _do() -> None:
        body = json.dumps({
            "type": sub_type,
            "version": version,
            "condition": condition,
            "transport": {"method": "websocket", "session_id": session_id},
        }).encode("utf-8")
        headers = _helix_user_headers() if use_user_token else _helix_headers()
        req = urllib.request.Request(
            "https://api.twitch.tv/helix/eventsub/subscriptions",
            data=body, method="POST",
            headers={**headers, "Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)

    try:
        await asyncio.get_event_loop().run_in_executor(None, _do)
        log.info("[twitch] eventsub subscribed: %s", sub_type)
    except urllib.error.HTTPError as e:
        if e.code == 401 and not use_user_token:
            state.twitch_app_token = ""
            try:
                await asyncio.get_event_loop().run_in_executor(None, _do)
                log.info("[twitch] eventsub subscribed: %s", sub_type)
                return
            except Exception as e2:
                e = e2
        body_text = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
        log.warning("[twitch] eventsub subscribe %s failed: %s %s", sub_type, e, body_text)
    except Exception as e:
        log.warning("[twitch] eventsub subscribe %s failed: %s", sub_type, e)


async def twitch_eventsub_loop() -> None:
    # import here to avoid a circular import with redeems.py
    from redeems import handle_redemption

    if not TWITCH_CLIENT_ID or not get_twitch_user_token():
        log.info("[twitch] no user token available (run `python main.py --auth`), follow/raid/redeem/sub/bits alerts disabled")
        return

    while True:
        try:
            uid = resolve_twitch_user_id()
            if not uid:
                await asyncio.sleep(30)
                continue

            async with websockets.connect("wss://eventsub.wss.twitch.tv/ws") as ws:
                welcome = json.loads(await ws.recv())
                session_id = welcome["payload"]["session"]["id"]

                mod_uid = _resolve_twitch_bot_user_id() or uid
                await _twitch_eventsub_subscribe(
                    session_id, "channel.follow", "2",
                    {"broadcaster_user_id": uid, "moderator_user_id": mod_uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.raid", "1",
                    {"to_broadcaster_user_id": uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.channel_points_custom_reward_redemption.add", "1",
                    {"broadcaster_user_id": uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.subscribe", "1",
                    {"broadcaster_user_id": uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.subscription.message", "1",
                    {"broadcaster_user_id": uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.cheer", "1",
                    {"broadcaster_user_id": uid},
                    use_user_token=True,
                )
                await _twitch_eventsub_subscribe(
                    session_id, "channel.ad_break.begin", "1",
                    {"broadcaster_user_id": uid},
                    use_user_token=True,
                )

                async for raw in ws:
                    msg = json.loads(raw)
                    meta = msg.get("metadata", {})
                    if meta.get("message_type") != "notification":
                        continue
                    payload = msg.get("payload", {})
                    sub_type = payload.get("subscription", {}).get("type")
                    event = payload.get("event", {})

                    if sub_type == "channel.follow":
                        broadcast_sync({"type": "follow", "user": event.get("user_name", "someone")})
                    elif sub_type == "channel.raid":
                        broadcast_sync({
                            "type": "raid",
                            "user": event.get("from_broadcaster_user_name", "someone"),
                            "viewers": event.get("viewers", 0),
                        })
                    elif sub_type == "channel.channel_points_custom_reward_redemption.add":
                        user = event.get("user_name") or event.get("user_login", "someone")
                        reward = event.get("reward", {}).get("title", "")
                        user_input = event.get("user_input", "")
                        handle_redemption(reward, user, user_input)
                    elif sub_type == "channel.subscribe":
                        if not event.get("is_gift"):
                            user = event.get("user_name") or event.get("user_login", "someone")
                            broadcast_sync({"type": "alert", "alert": "sub", "message": user, "sub": event.get("tier", "")})
                    elif sub_type == "channel.subscription.message":
                        user = event.get("user_name") or event.get("user_login", "someone")
                        months = event.get("cumulative_months", 0)
                        broadcast_sync({"type": "alert", "alert": "resub", "message": user, "sub": f"{months} months"})
                    elif sub_type == "channel.cheer":
                        user = event.get("user_name") or event.get("user_login", "anonymous")
                        bits = event.get("bits", 0)
                        broadcast_sync({"type": "alert", "alert": "bits", "message": user, "sub": f"{bits} bits"})
                    elif sub_type == "channel.ad_break.begin":
                        handle_ad_break_begin(event.get("duration_seconds", 0), event.get("is_automatic"))
        except Exception as e:
            log.warning("[twitch] eventsub connection dropped: %s — retrying in 10s", e)
            await asyncio.sleep(10)


# ── ad break reminder ────────────────────────────────────────────────────

def get_ad_schedule(broadcaster_id: str) -> dict | None:
    try:
        data = _helix_get("https://api.twitch.tv/helix/channels/ads", {"broadcaster_id": broadcaster_id})
        rows = data.get("data", [])
        return rows[0] if rows else None
    except Exception as e:
        log.warning("[ads] get-ad-schedule failed: %s", e)
        return None


def snooze_next_ad(broadcaster_id: str) -> dict | None:
    import urllib.request
    try:
        req = urllib.request.Request(
            f"https://api.twitch.tv/helix/channels/ads/schedule/snooze?broadcaster_id={broadcaster_id}",
            data=b"", method="POST",
            headers=_helix_user_headers(),
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rows = data.get("data", [])
        return rows[0] if rows else None
    except Exception as e:
        log.warning("[ads] snooze failed: %s", e)
        return None


def handle_ad_break_begin(duration_seconds, is_automatic) -> None:
    ads_state = state.data["ads"]
    ads_state["in_ad_break"] = True
    ads_state["warned"] = False
    state.data.setdefault("stats", {})
    msg = AD_REMINDER_START_MESSAGE.format(duration=duration_seconds)
    if ads_state.get("enabled", True):
        send_chat(msg)
    broadcast_sync({"type": "ad_break", "phase": "start", "duration": duration_seconds, "automatic": bool(is_automatic)})
    broadcast_sync({"type": "ads_state", "ads": ads_state})

    def _end_after() -> None:
        try:
            time.sleep(max(1, int(duration_seconds or 0)))
        except Exception:
            pass
        ads_state["in_ad_break"] = False
        if ads_state.get("enabled", True):
            send_chat(AD_REMINDER_END_MESSAGE)
        broadcast_sync({"type": "ad_break", "phase": "end"})
        broadcast_sync({"type": "ads_state", "ads": ads_state})

    threading.Thread(target=_end_after, daemon=True, name="ad-break-end").start()


def _parse_ad_timestamp(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        return ts / 1000.0 if ts > 10_000_000_000 else ts

    value = str(value).strip()
    if not value:
        return None
    if value.isdigit():
        ts = float(value)
        return ts / 1000.0 if ts > 10_000_000_000 else ts
    try:
        cleaned = value.split("+")[0].split("Z")[0]
        return calendar.timegm(time.strptime(cleaned, "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


def run_ad_schedule_thread() -> None:
    if not TWITCH_CLIENT_ID:
        return
    while True:
        try:
            ads_state = state.data["ads"]
            if not ads_state.get("enabled", True):
                time.sleep(AD_SCHEDULE_POLL_INTERVAL)
                continue

            uid = resolve_twitch_user_id()
            if not uid:
                time.sleep(AD_SCHEDULE_POLL_INTERVAL)
                continue

            schedule = get_ad_schedule(uid)
            if schedule:
                next_ad_at = schedule.get("next_ad_at") or ""
                ads_state["next_ad_at"] = next_ad_at
                ads_state["duration"] = schedule.get("duration", 0)

                if next_ad_at and not ads_state.get("in_ad_break"):
                    next_ts = _parse_ad_timestamp(next_ad_at)
                    seconds_until = (next_ts - time.time()) if next_ts is not None else None

                    if seconds_until is not None and 0 < seconds_until <= AD_REMINDER_WARN_SECONDS and not ads_state.get("warned"):
                        ads_state["warned"] = True
                        minutes = max(1, round(seconds_until / 60))
                        send_chat(AD_REMINDER_WARN_MESSAGE.format(minutes=minutes))
                        broadcast_sync({"type": "ad_break", "phase": "warn", "seconds_until": seconds_until})
                    elif seconds_until is not None and seconds_until > AD_REMINDER_WARN_SECONDS:
                        ads_state["warned"] = False

                broadcast_sync({"type": "ads_state", "ads": ads_state})
        except Exception:
            log.warning("[ads] poll loop error:\n%s", traceback.format_exc())
        time.sleep(AD_SCHEDULE_POLL_INTERVAL)
