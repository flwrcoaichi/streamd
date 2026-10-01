import asyncio
import json
import re
import traceback

import websockets

from config import log, BASE_DIR, MEDIA_DIR, MEDIA_EXTS, TYPEWRITER_DELAY
from state import state
from broadcast import broadcast, broadcast_sync, send_chat
from helpers import write_atomic
from obs import obs_dispatch, obs_set_words_visibility
from commands import save_commands, handle_lyrics_command
from redeems import save_rewards, handle_redemption
from tts import (
    tts_say, tts_skip, tts_clear_queue, tts_set_enabled, _tts_list_voices,
)
from twitch_api import (
    resolve_twitch_user_id, snooze_next_ad, set_channel_title, set_channel_category,
    set_channel_tags, add_channel_tag,
)


def normalize_key_name(name: object) -> str:
    text = str(name or "").strip().lower().replace("key.", "")
    aliases = {
        "spacebar": "space",
        "arrowup": "up",
        "uparrow": "up",
        "arrow-down": "down",
        "arrowdown": "down",
        "downarrow": "down",
        "arrow-left": "left",
        "arrowleft": "left",
        "leftarrow": "left",
        "arrow-right": "right",
        "arrowright": "right",
        "rightarrow": "right",
        "leftctrl": "ctrl",
        "rightctrl": "ctrl",
        "ctrlleft": "ctrl",
        "ctrlright": "ctrl",
        "leftalt": "alt",
        "rightalt": "alt",
        "altleft": "alt",
        "altright": "alt",
        "leftshift": "shift",
        "rightshift": "shift",
        "shiftleft": "shift",
        "shiftright": "shift",
        "return": "enter",
        "enterkey": "enter",
        "esc": "esc",
        "escape": "esc",
        "del": "delete",
        "backspace": "backspace",
        "pgup": "pageup",
        "pageup": "pageup",
        "pgdown": "pagedown",
        "pagedown": "pagedown",
    }
    text = text.replace("_", "").replace("-", "")
    if text in aliases:
        return aliases[text]
    if text in (" ", "space"):
        return "space"
    if text.startswith("'") and text.endswith("'") and len(text) >= 3:
        text = text[1:-1]
    text = text.replace(" ", "")
    return aliases.get(text, text)


def _key_panel_label_for_name(key_name: str, explicit: object | None = None) -> str:
    glyphs = {"up": "↑", "down": "↓", "left": "←", "right": "→"}
    if explicit is not None and str(explicit).strip():
        value = str(explicit).strip()
        normalized = normalize_key_name(value)
        if normalized in glyphs:
            return glyphs[normalized]
        if normalized == "space":
            return "SPACE"
        return value
    if key_name in glyphs:
        return glyphs[key_name]
    if key_name == "space":
        return "SPACE"
    return key_name.upper()


def normalize_key_panel_config(cfg: object) -> dict:
    base = {
        "shape": "round",
        "size": 48,
        "gap": 8,
        "glow": True,
        "border": False,
        "border_color": "#ffffff",
        "border_width": 1,
        "corner_radius": None,
        "active_color": "#7ef7c6",
        "inactive_color": "#1f2731",
        "text_color": "#f5f7fa",
        "keys": [],
        "active_keys": [],
    }
    if not isinstance(cfg, dict):
        cfg = {}
    out = {**base, **cfg}
    out["glow"] = bool(out.get("glow", True))
    out["border"] = bool(out.get("border", False))
    out["border_width"] = max(0, int(float(str(out.get("border_width", 1)).strip())) if str(out.get("border_width", 1)).strip() not in ("", "None", "null") else 1)
    if out.get("border_color") is None:
        out["border_color"] = "#ffffff"
    if out.get("corner_radius") in (None, "", "None", "null"):
        out["corner_radius"] = None
    else:
        try:
            out["corner_radius"] = int(float(str(out["corner_radius"]).strip()))
        except (TypeError, ValueError):
            out["corner_radius"] = str(out["corner_radius"]).strip() or None
    raw_keys = out.get("keys", [])
    if not isinstance(raw_keys, list):
        raw_keys = []

    def _as_int(value):
        if value is None or value == "":
            return None
        try:
            return int(float(str(value).strip()))
        except (TypeError, ValueError):
            return None

    normalized_keys: list[dict] = []
    for entry in raw_keys:
        item: dict
        parts: list[str] = []
        if isinstance(entry, str):
            parts = [p.strip() for p in entry.replace(";", "|").split("|") if p.strip()]
            if not parts:
                continue
            key_name = parts[0]
            color = parts[1] if len(parts) > 1 else "#7ef7c6"
            shape = parts[2] if len(parts) > 2 else "round"
            item = {"key": key_name, "label": key_name, "color": color, "shape": shape}
            if len(parts) >= 5:
                item["x"] = parts[3]
                item["y"] = parts[4]
            elif len(parts) == 4 and ("," in parts[3] or ":" in parts[3]):
                pos_parts = [p.strip() for p in re.split(r"[, :]+", parts[3]) if p.strip()]
                if len(pos_parts) >= 2:
                    item["x"] = pos_parts[0]
                    item["y"] = pos_parts[1]
            elif len(parts) == 4:
                item["x"] = parts[3]
        elif isinstance(entry, dict):
            item = dict(entry)
        else:
            continue

        key_name = normalize_key_name(item.get("key") or item.get("label") or "")
        if not key_name:
            continue
        label = str(item.get("label") if item.get("label") is not None else _key_panel_label_for_name(key_name)).strip()
        if not label:
            label = _key_panel_label_for_name(key_name)
        if key_name == "space" and label.lower() == "space":
            label = "SPACE"
        shape_name = str(item.get("shape") or "round").lower()
        allowed_shapes = {"round", "square", "pill", "diamond", "circle"}
        if shape_name not in allowed_shapes:
            shape_name = "round"
        x_val = _as_int(item.get("x"))
        y_val = _as_int(item.get("y"))
        if x_val is None and isinstance(item.get("position"), (list, tuple)) and len(item["position"]) >= 2:
            x_val = _as_int(item["position"][0])
            y_val = _as_int(item["position"][1])
        elif x_val is None and isinstance(item.get("position"), str):
            pos_parts = [p.strip() for p in re.split(r"[, :]+", item["position"]) if p.strip()]
            if len(pos_parts) >= 2:
                x_val = _as_int(pos_parts[0])
                y_val = _as_int(pos_parts[1])
        out_key = {
            "key": key_name,
            "label": label if label else _key_panel_label_for_name(key_name),
            "shape": shape_name,
            "color": item.get("color") or item.get("fill") or out.get("active_color") or "#7ef7c6",
            "bg_color": item.get("bg_color") or item.get("background") or out.get("inactive_color") or "#1f2731",
            "active": bool(item.get("active", False)),
        }
        if x_val is not None:
            out_key["x"] = x_val
        if y_val is not None:
            out_key["y"] = y_val
        normalized_keys.append(out_key)

    out["keys"] = normalized_keys
    active_keys = []
    for key in out.get("active_keys", []):
        key_name = normalize_key_name(key)
        if key_name:
            active_keys.append(key_name)
    out["active_keys"] = active_keys
    for item in out["keys"]:
        item["active"] = normalize_key_name(item.get("key")) in set(active_keys)
    return out


def update_key_panel_press_state(key_name: str, active: bool) -> dict:
    panel = normalize_key_panel_config(state.data.get("key_panel", {}))
    norm = normalize_key_name(key_name)
    if not norm:
        return panel
    active_keys = set(panel.get("active_keys", []))
    if active:
        active_keys.add(norm)
    else:
        active_keys.discard(norm)
    panel["active_keys"] = sorted(active_keys)
    for item in panel["keys"]:
        item["active"] = normalize_key_name(item.get("key")) in active_keys
    state.data["key_panel"] = panel
    return panel


def _resolve_scene_from_status(status: str) -> str:
    v = (status or "").strip().lower()
    if not v:
        return "live"
    if v.startswith("playing:") or v.startswith("playing"):
        return "playing"
    if v.startswith("starting"):
        return "starting"
    if v.startswith("brb") or "be right back" in v or "technical" in v:
        return "brb"
    if v.startswith("ending"):
        return "ending"
    return "live"


async def _typewriter_broadcast(text: str) -> None:
    state.data["message"] = text
    for i in range(1, len(text) + 1):
        await broadcast({"type": "message", "value": text[:i]})
        await asyncio.sleep(TYPEWRITER_DELAY)
    write_atomic(BASE_DIR / "message", text)


def run_key_panel_listener() -> None:
    try:
        from pynput import keyboard
    except ImportError:
        log.info("[key_panel] pynput not installed — key-panel listener disabled")
        return
    except Exception as e:
        log.warning("[key_panel] failed to import pynput: %s", e)
        return

    def _active_key_names() -> set[str]:
        panel = normalize_key_panel_config(state.data.get("key_panel", {}))
        return {normalize_key_name(item.get("key", "")) for item in panel.get("keys", []) if normalize_key_name(item.get("key", ""))}

    def handle_key(key, pressed: bool) -> None:
        name = str(key)
        if hasattr(key, "char") and key.char is not None:
            name = key.char
        elif hasattr(key, "name"):
            name = key.name
        norm = normalize_key_name(name)
        if not norm:
            return
        if norm not in _active_key_names():
            return
        update_key_panel_press_state(norm, pressed)
        from broadcast import broadcast_sync
        broadcast_sync({"type": "key_panel", "key_panel": state.data["key_panel"]})

    try:
        with keyboard.Listener(on_press=lambda key: handle_key(key, True), on_release=lambda key: handle_key(key, False)) as listener:
            log.info("[key_panel] keyboard listener active")
            listener.join()
    except Exception as e:
        log.warning("[key_panel] %s", e)


WM_STATE_PATH = BASE_DIR / "wm_state.json"
NOTEPADS_PATH = BASE_DIR / "notepads.json"


def _overlay_name(name: object) -> str:
    return re.sub(r"[^\w\-]", "_", str(name or "main").strip())[:40] or "main"


def load_wm_layouts() -> dict:
    try:
        data = json.loads(WM_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    layouts = data.get("wm_layouts")
    if not isinstance(layouts, dict):
        layouts = {"main": data.get("wm_layout") or []}
    return layouts


def save_wm_layouts() -> None:
    write_atomic(WM_STATE_PATH, json.dumps({"wm_layouts": state.data["wm_layouts"]}, indent=2))


def load_notepads() -> dict:
    try:
        data = json.loads(NOTEPADS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


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
                    state.data["scene"] = _resolve_scene_from_status(val)
                    write_atomic(BASE_DIR / "starting", val)
                    log.info("status → %s (scene=%s)", val, state.data["scene"])
                    await broadcast({"type": "status", "value": val})
                    await broadcast({"type": "scene", "value": state.data["scene"]})

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
                elif cmd == "wm_layout_set":
                    layout = msg.get("layout", [])
                    if isinstance(layout, list):
                        name = _overlay_name(msg.get("name"))
                        state.data["wm_layouts"][name] = layout
                        if name == "main":
                            state.data["wm_layout"] = layout
                        save_wm_layouts()
                        await broadcast({"type": "wm_layout", "name": name, "layout": layout})
                elif cmd == "wm_layout_delete":
                    name = _overlay_name(msg.get("name"))
                    if name != "main" and state.data["wm_layouts"].pop(name, None) is not None:
                        save_wm_layouts()
                        await broadcast({"type": "wm_layout_deleted", "name": name})
                elif cmd == "notepad_set":
                    pid = str(msg.get("id", ""))[:60]
                    if pid:
                        state.data["notepads"][pid] = str(val)[:20000]
                        write_atomic(NOTEPADS_PATH, json.dumps(state.data["notepads"]))
                        await broadcast({"type": "notepad", "id": pid, "value": state.data["notepads"][pid]})
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

                elif cmd == "key_panel_set":
                    panel = normalize_key_panel_config(msg.get("key_panel", {}))
                    state.data["key_panel"] = panel
                    await broadcast({"type": "key_panel", "key_panel": panel})

                elif cmd == "key_panel_press":
                    key_name = normalize_key_name(msg.get("key", ""))
                    if key_name:
                        panel = update_key_panel_press_state(key_name, bool(msg.get("pressed", True)))
                        await broadcast({"type": "key_panel", "key_panel": panel})

                elif cmd == "words_set":
                    active = bool(msg.get("value", False))
                    state.data["words"]["active"] = active
                    asyncio.create_task(obs_set_words_visibility(active))
                    await broadcast({"type": "words_state", "words": state.data["words"]})

                elif cmd == "canvas_show":
                    from canvas import show_canvas
                    seconds = msg.get("seconds")
                    show_canvas(float(seconds) if seconds else None)

                elif cmd == "canvas_place":
                    from canvas import place_pixel
                    user = msg.get("user", "someone")
                    x = int(msg.get("x", -1))
                    y = int(msg.get("y", -1))
                    color = msg.get("color", "")
                    ok, result_message = await asyncio.to_thread(place_pixel, user, x, y, color)
                    await ws.send(json.dumps({"type": "canvas_place_result", "ok": ok, "message": result_message}))

                elif cmd == "canvas_grant":
                    # manual credit grant from control.html, for testing / manual awards
                    from canvas import add_credits
                    user = msg.get("user", "").strip()
                    amount = int(msg.get("amount", 0) or 0)
                    if user and amount:
                        total = add_credits(user, amount)
                        await ws.send(json.dumps({"type": "canvas_grant_result", "ok": True, "user": user, "credits": total}))

                elif cmd == "canvas_clear":
                    state.data["canvas"]["pixels"] = {}
                    from canvas import save_canvas
                    save_canvas()
                    await broadcast({"type": "canvas_state", "canvas": state.data["canvas"]})

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