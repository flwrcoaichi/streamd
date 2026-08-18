import asyncio
import json
import traceback

import websockets

from config import log, BASE_DIR, MEDIA_DIR, MEDIA_EXTS, TYPEWRITER_DELAY
from state import state
from broadcast import broadcast, broadcast_sync, send_chat
from helpers import write_atomic
from obs import obs_dispatch
from commands import save_commands, handle_lyrics_command
from redeems import save_rewards, handle_redemption
from tts import (
    tts_say, tts_skip, tts_clear_queue, tts_set_enabled, _tts_list_voices,
)
from twitch_api import (
    resolve_twitch_user_id, snooze_next_ad, set_channel_title, set_channel_category,
    set_channel_tags, add_channel_tag,
)


async def _typewriter_broadcast(text: str) -> None:
    state.data["message"] = text
    for i in range(1, len(text) + 1):
        await broadcast({"type": "message", "value": text[:i]})
        await asyncio.sleep(TYPEWRITER_DELAY)
    write_atomic(BASE_DIR / "message", text)


async def ws_handler(ws) -> None:
    with state.clients_lock:
        state.clients.add(ws)
    log.info("client connected (%d total)", len(state.clients))

    try:
        await ws.send(json.dumps({"type": "init", "state": state.data}))
    except Exception as e:
        log.warning("init send failed: %s", e)
        with state.clients_lock:
            state.clients.discard(ws)
        return

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            try:
                cmd = msg.get("cmd")
                val = msg.get("value", "")

                if cmd == "status":
                    state.data["status"] = val
                    write_atomic(BASE_DIR / "starting", val)
                    log.info("status → %s", val)
                    await broadcast({"type": "status", "value": val})

                elif cmd == "message":
                    asyncio.create_task(_typewriter_broadcast(val))

                elif cmd == "clear_message":
                    state.data["message"] = ""
                    await broadcast({"type": "message", "value": ""})

                elif cmd == "scene":
                    state.data["scene"] = val
                    log.info("scene → %s", val)
                    await broadcast({"type": "scene", "value": val})

                elif cmd == "set_extra":
                    state.data["extra"] = val
                    await broadcast({"type": "extra", "value": val})

                elif cmd == "tts_say":
                    tts_say(msg.get("value", ""), msg.get("voice"))
                elif cmd == "tts_skip":
                    tts_skip()
                elif cmd == "tts_clear":
                    tts_clear_queue()
                elif cmd == "tts_toggle":
                    tts_set_enabled(not state.tts_state()["enabled"])
                elif cmd == "tts_list_voices":
                    state.tts_state()["voices"] = sorted(_tts_list_voices().keys())
                    await broadcast({"type": "tts_state", "tts": state.tts_state()})

                elif cmd == "ads_toggle":
                    state.data["ads"]["enabled"] = not state.data["ads"].get("enabled", True)
                    await broadcast({"type": "ads_state", "ads": state.data["ads"]})

                elif cmd == "ads_snooze":
                    uid = await asyncio.to_thread(resolve_twitch_user_id)
                    result = await asyncio.to_thread(snooze_next_ad, uid) if uid else None
                    if result:
                        state.data["ads"]["next_ad_at"] = result.get("next_ad_at", "")
                        await broadcast({"type": "ads_state", "ads": state.data["ads"]})

                elif cmd == "list_media":
                    files = sorted(
                        p.name for p in MEDIA_DIR.iterdir()
                        if p.is_file() and p.suffix.lower() in MEDIA_EXTS
                    ) if MEDIA_DIR.exists() else []
                    await ws.send(json.dumps({"type": "media_list", "files": files}))

                elif cmd == "test_play_media":
                    filename = msg.get("file", "")
                    if filename and (MEDIA_DIR / filename).exists():
                        payload = {"type": "play_media", "reward": "test", "user": msg.get("user", "test_user"), "file": filename}
                        audio_file = msg.get("audio", "")
                        if audio_file and (MEDIA_DIR / audio_file).exists():
                            payload["audio"] = audio_file
                        await broadcast(payload)

                elif cmd == "set_scheduled":
                    state.data["schedule"]["scheduled_today"] = bool(msg.get("value", False))
                    await broadcast({"type": "schedule", "schedule": state.data["schedule"]})

                elif cmd == "set_offline_text":
                    state.data["schedule"]["offline_text"] = val
                    await broadcast({"type": "schedule", "schedule": state.data["schedule"]})

                elif cmd == "set_pngtuber_mood":
                    state.data["pngtuber"]["mood"] = val
                    log.info("pngtuber mood → %s", val)
                    await broadcast({"type": "pngtuber", "pngtuber": state.data["pngtuber"]})

                elif cmd and cmd.startswith("media_"):
                    from ytmusic_bridge import media_control
                    media_control(cmd[len("media_"):])

                elif cmd == "request_song":
                    from ytmusic_bridge import request_song
                    query = val.strip()
                    user = msg.get("user", "someone")
                    if query:
                        ok, result_message = await asyncio.to_thread(request_song, query, user)
                        await broadcast({
                            "type": "redeem_alert", "reward": "song request",
                            "user": user, "message": result_message,
                        })
                        if ok:
                            send_chat(result_message)

                elif cmd and cmd.startswith("obs_"):
                    asyncio.create_task(obs_dispatch(cmd, msg))

                elif cmd == "send_chat":
                    text = val.strip()
                    if text:
                        send_chat(text)
                        log.info("chat sent: %s", text)
                        await broadcast({"type": "bot_say", "text": text})

                elif cmd == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

                elif cmd == "test_alert":
                    kind = msg.get("alert", "follow")
                    user = msg.get("user", "test_user")
                    if kind == "raid":
                        await broadcast({"type": "raid", "user": user, "viewers": msg.get("viewers", 42)})
                    elif kind in ("sub", "resub", "bits"):
                        sub_map = {"sub": "tier 1", "resub": "3 months", "bits": "100 bits"}
                        await broadcast({"type": "alert", "alert": kind, "message": user, "sub": sub_map.get(kind, "")})
                    else:
                        await broadcast({"type": "follow", "user": user})

                elif cmd == "commands_set":
                    new_cmds = msg.get("commands", {})
                    state.data["commands"] = new_cmds
                    save_commands(new_cmds)
                    log.info("commands updated (%d)", len(new_cmds))
                    await broadcast({"type": "commands_updated", "commands": new_cmds})

                elif cmd == "command_set":
                    trigger = msg.get("trigger", "").lower()
                    cmd_data = msg.get("data", {})
                    if trigger:
                        state.data["commands"][trigger] = cmd_data
                        save_commands(state.data["commands"])
                        await broadcast({"type": "commands_updated", "commands": state.data["commands"]})

                elif cmd == "command_delete":
                    trigger = msg.get("trigger", "").lower()
                    if trigger and trigger in state.data["commands"]:
                        del state.data["commands"][trigger]
                        save_commands(state.data["commands"])
                        await broadcast({"type": "commands_updated", "commands": state.data["commands"]})

                elif cmd == "reward_set":
                    title = msg.get("title", "")
                    cfg_data = msg.get("data", {})
                    if title:
                        state.data["rewards"][title] = cfg_data
                        save_rewards(state.data["rewards"])
                        await broadcast({"type": "rewards_updated", "rewards": state.data["rewards"]})

                elif cmd == "reward_delete":
                    title = msg.get("title", "")
                    if title and title in state.data["rewards"]:
                        del state.data["rewards"][title]
                        save_rewards(state.data["rewards"])
                        await broadcast({"type": "rewards_updated", "rewards": state.data["rewards"]})

                elif cmd == "test_redeem":
                    title = msg.get("title", "")
                    user = msg.get("user", "test_user")
                    arg = msg.get("arg", "")
                    if title:
                        handle_redemption(title, user, arg)

                elif cmd == "test_lyrics":
                    handle_lyrics_command(msg.get("user", "test_user"))

                elif cmd == "set_title":
                    title = msg.get("value", "").strip()
                    if title:
                        await asyncio.to_thread(set_channel_title, title, True)

                elif cmd == "set_category":
                    name = msg.get("value", "").strip()
                    if name:
                        await asyncio.to_thread(set_channel_category, name)

                elif cmd == "set_tags":
                    tags = msg.get("value", [])
                    if isinstance(tags, list):
                        await asyncio.to_thread(set_channel_tags, tags)

                elif cmd == "add_tag":
                    tag = msg.get("value", "").strip()
                    if tag:
                        await asyncio.to_thread(add_channel_tag, tag)

            except websockets.exceptions.ConnectionClosed:
                raise
            except Exception as e:
                log.error("ws_handler: error handling cmd %r: %s", msg.get("cmd"), e)
                log.debug("ws_handler traceback:\n%s", traceback.format_exc())

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log.error("ws_handler error: %s", e)
    finally:
        with state.clients_lock:
            state.clients.discard(ws)
        log.info("client disconnected (%d remaining)", len(state.clients))
