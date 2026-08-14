import json
import random

from config import log, BASE_DIR
from state import state
from broadcast import broadcast_sync

FLAGS_PATH = BASE_DIR / "flags.json"


def load_flags() -> dict:
    if FLAGS_PATH.exists():
        try:
            return json.loads(FLAGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_flags(flags: dict) -> None:
    try:
        FLAGS_PATH.write_text(json.dumps(flags, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("failed to save flags: %s", e)


def get_flags(user: str) -> int:
    return state.data.setdefault("flags", {}).get(user.lower(), 0)


def _broadcast_flag_event(user: str, delta: int) -> None:
    flags = state.data["flags"]
    board = [{"user": u, "count": c} for u, c in flags.items() if c > 0]
    board.sort(key=lambda e: e["count"], reverse=True)
    broadcast_sync({
        "type": "flags_event",
        "user": user,
        "delta": delta,
        "total": flags.get(user.lower(), 0),
        "board": board,
    })


def add_flags(user: str, delta: int) -> int:
    if delta == 0:
        return get_flags(user)
    key = user.lower()
    flags = state.data.setdefault("flags", {})
    new_total = max(0, flags.get(key, 0) + delta)
    flags[key] = new_total
    save_flags(flags)
    _broadcast_flag_event(user, delta)
    if new_total >= 50:
        log.info("[flags] %s reached %d flags - check in about the $100", user, new_total)
    return new_total


def roll_flag_gamble(user: str) -> int:
    """50/50 gain or lose a flag"""
    delta = 1 if random.random() < 0.5 else -1
    if delta < 0 and get_flags(user) <= 0:
        delta = 0
    if delta != 0:
        add_flags(user, delta)
    return delta


def roll_flag_jackpot(user: str) -> int:
    """10% +3, 10% -half, 20% +1, 20% -1, 40% nothing"""
    r = random.random()
    current = get_flags(user)
    if r < 0.10:
        delta = 3
    elif r < 0.20:
        delta = -(current // 2)
    elif r < 0.40:
        delta = 1
    elif r < 0.60:
        delta = -1 if current > 0 else 0
    else:
        delta = 0
    if delta != 0:
        add_flags(user, delta)
    return delta
