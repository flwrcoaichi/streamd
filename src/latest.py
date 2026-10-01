import json

from config import BASE_DIR
from state import state
from broadcast import broadcast_sync
from helpers import write_atomic

LATEST_PATH = BASE_DIR / "latest.json"


def load_latest() -> dict:
    out = {"follower": "", "sub": ""}
    try:
        data = json.loads(LATEST_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            out.update({k: str(data.get(k) or "") for k in out})
    except Exception:
        pass
    return out


def set_latest(kind: str, user: str | None) -> None:
    if not user:
        return
    latest = state.data.setdefault("latest", {"follower": "", "sub": ""})
    if latest.get(kind) == user:
        return
    latest[kind] = user
    write_atomic(LATEST_PATH, json.dumps(latest))
    broadcast_sync({"type": "latest", "latest": latest})
