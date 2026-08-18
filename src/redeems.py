import json
import re
import threading
import time

from config import log, REWARDS_PATH, CHECKINS_PATH, REDEEMS_DIR, MEDIA_DIR
from state import state
from broadcast import broadcast_sync, send_chat
from conditions import check_conditions

_DEFAULT_REWARDS = {
    "first in chat": {
        "enabled": True,
        "action": "first_in_chat",
        "message": "{user} was first in chat today! 🎉",
        "description": "lets the redeemer know they were first in chat",
    },
    "check-in": {
        "enabled": True,
        "action": "check_in",
        "message": "{user} has checked in {count} time(s)!",
        "description": "counts how many times this person has checked in",
    },
    "leave a note": {
        "enabled": True,
        "action": "write_file",
        "message": "{user} left a note on the desktop!",
        "description": "drops a timestamped text file on disk",
    },
    "text to speech": {
        "enabled": True,
        "action": "tts",
        "message": "",
        "voice": "",
        "description": "reads the redeemer's input aloud with TTS",
    },
    "snooze ad break": {
        "enabled": True,
        "action": "snooze_ad",
        "message": "{user} pushed the next ad back a few minutes!",
        "description": "delays the next automatic mid-roll ad by ~5 minutes",
    },
    "flag gamble": {
        "enabled": True,
        "action": "flag_gamble",
        "message": "",
        "description": "50/50 chance to gain or lose a flag",
    },
    "flag jackpot": {
        "enabled": True,
        "action": "flag_jackpot",
        "message": "",
        "description": "1% +3 flags, 1% -half flags, 20% -1 flag, 70% nothing",
    },
    "song request": {
        "enabled": True,
        "action": "song_request",
        "message": "",
        "description": "searches YouTube Music for the redeemer's input and plays it immediately",
    },
}


def load_rewards() -> dict:
    if REWARDS_PATH.exists():
        try:
            rewards = json.loads(REWARDS_PATH.read_text(encoding="utf-8"))
            for title, cfg in _DEFAULT_REWARDS.items():
                rewards.setdefault(title, cfg)
            return rewards
        except Exception:
            pass
    return dict(_DEFAULT_REWARDS)


def save_rewards(rewards: dict) -> None:
    try:
        REWARDS_PATH.write_text(json.dumps(rewards, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("failed to save rewards: %s", e)


def load_checkins() -> dict:
    if CHECKINS_PATH.exists():
        try:
            return json.loads(CHECKINS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_checkins(checkins: dict) -> None:
    try:
        CHECKINS_PATH.write_text(json.dumps(checkins, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("failed to save checkins: %s", e)


def _mark_first_chatter(user: str) -> bool:
    """returns True the first time this is called on a given calendar day."""
    today = time.strftime("%Y-%m-%d")
    if today != state.first_chatter_date:
        state.first_chatter_date = today
        state.first_chatter_today = None
    if state.first_chatter_today is None:
        state.first_chatter_today = user
        return True
    return False


def _log_redeem(reward_title: str, user: str, message: str) -> None:
    entry = {
        "reward": reward_title,
        "user": user,
        "message": message,
        "ts": time.strftime("%H:%M:%S"),
    }
    log_list = state.data.setdefault("redeem_log", [])
    log_list.append(entry)
    del log_list[:-30]
    broadcast_sync({"type": "redeem", **entry})


def _write_redeem_file(user: str, user_input: str) -> None:
    ts = time.strftime("%Y-%m-%d_%H-%M-%S")
    safe_user = re.sub(r"[^\w\-]", "_", user)[:40] or "someone"
    path = REDEEMS_DIR / f"{ts}_{safe_user}.txt"
    body = f"from: {user}\ntime: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n{user_input}\n"
    try:
        path.write_text(body, encoding="utf-8")
        log.info("[redeem] wrote note file: %s", path)
    except Exception as e:
        log.warning("[redeem] failed to write note file: %s", e)


def handle_redemption(reward_title: str, user: str, user_input: str = "", badges: list | None = None) -> None:
    """dispatch a channel point redemption by matching its reward title
    (case-insensitive) against the configured rewards table. `badges` is
    only populated when this is triggered from a test/chat context — real
    twitch redemption events don't carry badge info."""
    # local imports to avoid circular imports at module load time
    from tts import tts_say
    from twitch_api import resolve_twitch_user_id, snooze_next_ad, apply_first_chatter_title_suffix
    from flags import add_flags, roll_flag_gamble, roll_flag_jackpot
    from ytmusic_bridge import request_song

    rewards = state.data.get("rewards", {})
    key = None
    for title in rewards:
        if title.lower() == (reward_title or "").lower():
            key = title
            break
    if key is None:
        log.info("[redeem] no config for reward %r, ignoring", reward_title)
        return

    cfg = rewards[key]
    if not cfg.get("enabled", True):
        return

    if not check_conditions(cfg, user, badges):
        log.info("[redeem] %r blocked by conditions for %s", key, user)
        return

    action = cfg.get("action", "message")
    template = cfg.get("message", "")

    # song_request has its own message resolution (the search result IS the
    # message) so it's handled and logged separately from the shared
    # template-substitution path below.
    if action == "song_request":
        query = (user_input or "").strip()
        if not query:
            return
        ok, result_message = request_song(query, user)
        message = (template or result_message).replace("{user}", user).replace("{arg}", user_input)
        broadcast_sync({"type": "redeem_alert", "reward": key, "user": user, "message": message})
        send_chat(message)
        _log_redeem(key, user, message)
        return

    count = None
    if action == "first_in_chat":
        is_first = _mark_first_chatter(user)
        if not is_first:
            return
        threading.Thread(target=apply_first_chatter_title_suffix, args=(user,), daemon=True).start()
    elif action == "check_in":
        checkins = state.data.setdefault("checkins", {})
        checkins[user] = checkins.get(user, 0) + 1
        count = checkins[user]
        save_checkins(checkins)
    elif action == "write_file":
        _write_redeem_file(user, user_input)
    elif action == "tts":
        tts_say(user_input or template.replace("{user}", user), cfg.get("voice"))
    elif action == "snooze_ad":
        uid = resolve_twitch_user_id()
        result = snooze_next_ad(uid) if uid else None
        if not result:
            return
        state.data["ads"]["next_ad_at"] = result.get("next_ad_at", "")
        broadcast_sync({"type": "ads_state", "ads": state.data["ads"]})
    elif action == "flag_gamble":
        delta = roll_flag_gamble(user)
        template = template or (
            f"{{user}} gained a flag! 🚩" if delta > 0 else
            f"{{user}} lost a flag..." if delta < 0 else
            f"{{user}} broke even."
        )
    elif action == "flag_jackpot":
        delta = roll_flag_jackpot(user)
        if delta > 0:
            template = template or "{user} hit the jackpot! +3 flags!! 🚩🚩🚩"
        elif delta < 0:
            template = template or "{user} took a hit and lost flags."
        else:
            template = template or ""
    elif action == "play_media":
        filename = cfg.get("file", "")
        audio_file = cfg.get("audio", "")
        media_path = MEDIA_DIR / filename if filename else None
        if media_path and media_path.exists():
            payload = {"type": "play_media", "reward": key, "user": user, "file": filename}
            if audio_file:
                audio_path = MEDIA_DIR / audio_file
                if audio_path.exists():
                    payload["audio"] = audio_file
                else:
                    log.warning("[redeem] play_media: audio file %r not found in %s, playing video only", audio_file, MEDIA_DIR)
            broadcast_sync(payload)
            log.info("[redeem] play_media: %s%s (by %s)", filename, f" + {audio_file}" if payload.get("audio") else "", user)
        else:
            log.warning("[redeem] play_media: file %r not found in %s", filename, MEDIA_DIR)

    message = (template
               .replace("{user}", user)
               .replace("{arg}", user_input)
               .replace("{count}", str(count) if count is not None else ""))

    if message:
        broadcast_sync({"type": "redeem_alert", "reward": key, "user": user, "message": message})
        send_chat(message)

    _log_redeem(key, user, message)
