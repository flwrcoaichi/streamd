import asyncio
import json

from config import log, CHAN
from state import state


async def broadcast(msg: dict) -> None:
    payload = json.dumps(msg)
    with state.clients_lock:
        snapshot = set(state.clients)
    dead: set = set()
    for ws in snapshot:
        try:
            await ws.send(payload)
        except Exception:
            dead.add(ws)
    if dead:
        with state.clients_lock:
            state.clients.difference_update(dead)


def broadcast_sync(msg: dict) -> None:
    if state.main_loop is None:
        return
    asyncio.run_coroutine_threadsafe(broadcast(msg), state.main_loop)


def send_chat(msg: str) -> None:
    if state.irc_socket:
        try:
            state.irc_socket.send(f"PRIVMSG {CHAN} :{msg}\r\n".encode("utf-8"))
        except Exception as e:
            log.error("failed to send chat: %s", e)
