"""
canvas.py — a small collaborative pixel-art board.

Users earn pixel credits from various actions (redeems, gifts, subs,
cheers) and spend them one at a time by placing a pixel of any color on a
shared 100x100 grid. The canvas itself is only shown on stream
periodically (or on-demand via !canvas), per vanillyn's request — this is
a low-key extra for supporters, not a core feature with its own overlay
real estate at all times.

State lives in state.data["canvas"] = {size, visible, pixels}, where
`pixels` maps "x,y" -> "#rrggbb". Pending credits (pixels a user has
earned but not yet spent) live in state.canvas_credits, keyed by
lowercased username, and are NOT persisted to disk — they're meant to be
spent quickly (e.g. via a control-panel driven claim UI or a !pixel chat
command), not banked indefinitely across daemon restarts.
"""
import json
import random
import re
import threading
import time

from config import log, CANVAS_PATH, CANVAS_SIZE, CANVAS_SHOW_SECONDS, \
    CANVAS_MIN_INTERVAL_MIN, CANVAS_MAX_INTERVAL_MIN
from state import state
from broadcast import broadcast_sync

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def load_canvas() -> dict:
    if CANVAS_PATH.exists():
        try:
            data = json.loads(CANVAS_PATH.read_text(encoding="utf-8"))
            if isinstance(data.get("pixels"), dict):
                state.data["canvas"].setdefault("owners", {})
                if isinstance(data.get("owners"), dict):
                    state.data["canvas"]["owners"].update(data["owners"])
                return data["pixels"]
        except Exception:
            pass
    state.data["canvas"].setdefault("owners", {})
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


def add_credits(user: str, amount: int) -> int:
    """grants `amount` pending pixel credits to a user. returns their new total."""
    if amount <= 0:
        return get_credits(user)
    key = user.lower()
    with state.canvas_lock:
        state.canvas_credits[key] = state.canvas_credits.get(key, 0) + amount
        total = state.canvas_credits[key]
    broadcast_sync({"type": "canvas_credits", "user": user, "credits": total})
    return total


def get_credits(user: str) -> int:
    return state.canvas_credits.get(user.lower(), 0)


def place_public_pixel(user: str, x: int, y: int, color: str) -> tuple[bool, str]:
    """places a pixel for a public viewer without spending credits."""
    size = state.data["canvas"]["size"]
    if not (0 <= x < size and 0 <= y < size):
        return False, f"pixel out of bounds (canvas is {size}x{size})"
    if not _HEX_RE.match(color or ""):
        return False, "color must be a hex code like #ff8800"

    label = (user or "").strip()
    if not label:
        return False, "missing twitch username"
    owner = label.lower()
    key = f"{x},{y}"
    state.data["canvas"].setdefault("owners", {})
    state.data["canvas"]["pixels"][key] = color
    state.data["canvas"]["owners"][key] = owner
    save_canvas()
    broadcast_sync({
        "type": "canvas_pixel", "x": x, "y": y, "color": color, "user": owner,
    })
    return True, f"placed pixel at ({x},{y})"


def place_pixel(user: str, x: int, y: int, color: str) -> tuple[bool, str]:
    """spends one credit to place a pixel. returns (ok, message)."""
    size = state.data["canvas"]["size"]
    if not (0 <= x < size and 0 <= y < size):
        return False, f"pixel out of bounds (canvas is {size}x{size})"
    if not _HEX_RE.match(color or ""):
        return False, "color must be a hex code like #ff8800"

    key = user.lower()
    with state.canvas_lock:
        credits = state.canvas_credits.get(key, 0)
        if credits <= 0:
            return False, f"{user} has no pixel credits"
        state.canvas_credits[key] = credits - 1

    state.data["canvas"].setdefault("owners", {})
    state.data["canvas"]["pixels"][f"{x},{y}"] = color
    state.data["canvas"]["owners"][f"{x},{y}"] = key
    save_canvas()
    broadcast_sync({
        "type": "canvas_pixel", "x": x, "y": y, "color": color, "user": user,
    })
    return True, f"placed pixel at ({x},{y})"


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
    """periodically reveals the canvas for CANVAS_SHOW_SECONDS, at a random
    interval between CANVAS_MIN_INTERVAL_MIN and CANVAS_MAX_INTERVAL_MIN."""
    state.data["canvas"]["pixels"] = load_canvas()
    state.data["canvas"].setdefault("owners", {})
    while True:
        wait_min = random.uniform(CANVAS_MIN_INTERVAL_MIN, CANVAS_MAX_INTERVAL_MIN)
        time.sleep(max(1, wait_min * 60))
        try:
            show_canvas()
        except Exception as e:
            log.warning("[canvas] scheduled show failed: %s", e)