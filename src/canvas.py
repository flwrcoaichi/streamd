"""
canvas.py - a small collaborative pixel-art board.

Users earn pixel credits (redeems, gifts, subs, cheers) and spend one per
pixel. Credits live in state.canvas_credits (lowercased username) and are NOT
persisted across restarts. Users in CANVAS_UNLIMITED_USERS (the broadcaster by
default) never spend credits.

state.data["canvas"] = {size, visible, pixels: {"x,y": "#rrggbb"}, owners: {"x,y": user}}
"""
import json
import random
import re
import threading
import time

from config import log, CANVAS_PATH, CANVAS_SHOW_SECONDS, \
    CANVAS_MIN_INTERVAL_MIN, CANVAS_MAX_INTERVAL_MIN, CANVAS_UNLIMITED_USERS
from state import state
from broadcast import broadcast_sync

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def load_canvas() -> dict:
    state.data["canvas"].setdefault("owners", {})
    if CANVAS_PATH.exists():
        try:
            data = json.loads(CANVAS_PATH.read_text(encoding="utf-8"))
            if isinstance(data.get("pixels"), dict):
                if isinstance(data.get("owners"), dict):
                    state.data["canvas"]["owners"].update(data["owners"])
                return data["pixels"]
        except Exception:
            pass
    return {}


def save_canvas() -> None:
    try:
        payload = {
            "pixels": state.data["canvas"].get("pixels", {}),
            "owners": state.data["canvas"].get("owners", {}),
        }
        CANVAS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("[canvas] failed to save: %s", e)


def is_unlimited(user: str) -> bool:
    return (user or "").strip().lower() in CANVAS_UNLIMITED_USERS


def get_credits(user: str) -> int:
    return state.canvas_credits.get((user or "").lower(), 0)


def _announce_credits(key: str, total: int) -> None:
    broadcast_sync({"type": "canvas_credits", "user": key, "credits": total})


def add_credits(user: str, amount: int) -> int:
    """grants `amount` pending pixel credits to a user. returns their new total."""
    if amount <= 0:
        return get_credits(user)
    key = user.lower()
    with state.canvas_lock:
        total = state.canvas_credits[key] = state.canvas_credits.get(key, 0) + amount
    _announce_credits(key, total)
    return total


def place_pixel(user: str, x: int, y: int, color: str) -> tuple[bool, str]:
    """places one pixel, spending a credit unless the user is unlimited."""
    canvas = state.data["canvas"]
    size = canvas["size"]
    if not (0 <= x < size and 0 <= y < size):
        return False, f"pixel out of bounds (canvas is {size}x{size})"
    if not _HEX_RE.match(color or ""):
        return False, "color must be a hex code like #ff8800"
    key = (user or "").strip().lower()
    if not key:
        return False, "missing twitch username"

    if not is_unlimited(key):
        with state.canvas_lock:
            credits = state.canvas_credits.get(key, 0)
            if credits <= 0:
                return False, f"{user} has no pixel credits"
            state.canvas_credits[key] = credits - 1
        _announce_credits(key, credits - 1)

    pos = f"{x},{y}"
    canvas.setdefault("owners", {})
    canvas["pixels"][pos] = color
    canvas["owners"][pos] = key
    save_canvas()
    broadcast_sync({"type": "canvas_pixel", "x": x, "y": y, "color": color, "user": key})
    return True, f"placed pixel at ({x},{y})"


# the public page used to have its own near-identical copy of place_pixel
place_public_pixel = place_pixel


def show_canvas(seconds: float | None = None) -> None:
    state.data["canvas"]["visible"] = True
    broadcast_sync({"type": "canvas_state", "canvas": state.data["canvas"]})
    duration = seconds if seconds is not None else CANVAS_SHOW_SECONDS

    def _hide_after() -> None:
        time.sleep(max(1, duration))
        state.data["canvas"]["visible"] = False
        broadcast_sync({"type": "canvas_state", "canvas": state.data["canvas"]})

    threading.Thread(target=_hide_after, daemon=True, name="canvas-hide").start()


def run_canvas_schedule_thread() -> None:
    """periodically reveals the canvas for CANVAS_SHOW_SECONDS at a random interval."""
    state.data["canvas"]["pixels"] = load_canvas()
    while True:
        time.sleep(max(1, random.uniform(CANVAS_MIN_INTERVAL_MIN, CANVAS_MAX_INTERVAL_MIN) * 60))
        try:
            show_canvas()
        except Exception as e:
            log.warning("[canvas] scheduled show failed: %s", e)
