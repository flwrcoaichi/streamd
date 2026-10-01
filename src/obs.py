import asyncio
import base64
import hashlib
import json
import os
from typing import Any

import websockets

from config import log, OBS_WS_URL, OBS_WS_PASSWORD, OBS_WORDS_SCENE, OBS_WORDS_SOURCE
from state import state
from broadcast import broadcast_sync


class OBSClient:
    """minimal obs-websocket v5 client, no external deps"""

    def __init__(self, url: str, password: str) -> None:
        self.url = url
        self.password = password
        self.ws: Any | None = None
        self._req_id = 0
        self._pending: dict[str, asyncio.Future] = {}

    async def connect(self) -> None:
        ws = await websockets.connect(self.url, max_size=None)
        self.ws = ws
        hello = json.loads(await ws.recv())
        d = hello["d"]

        identify = {"op": 1, "d": {"rpcVersion": 1}}
        if d.get("authentication"):
            auth = d["authentication"]
            secret = base64.b64encode(
                hashlib.sha256((self.password + auth["salt"]).encode()).digest()
            ).decode()
            auth_response = base64.b64encode(
                hashlib.sha256((secret + auth["challenge"]).encode()).digest()
            ).decode()
            identify["d"]["authentication"] = auth_response

        await ws.send(json.dumps(identify))
        ack = json.loads(await ws.recv())
        if ack.get("op") != 2:
            raise RuntimeError(f"obs identify failed: {ack}")

    async def request(self, request_type: str, request_data: dict | None = None) -> dict:
        self._req_id += 1
        rid = str(self._req_id)
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        payload = {"op": 6, "d": {"requestType": request_type, "requestId": rid}}
        if request_data:
            payload["d"]["requestData"] = request_data

        ws = self.ws
        if ws is None:
            raise RuntimeError("OBS websocket is not connected")

        await ws.send(json.dumps(payload))
        return await asyncio.wait_for(fut, timeout=5)

    async def listen(self) -> None:
        ws = self.ws
        if ws is None:
            raise RuntimeError("OBS websocket is not connected")

        async for raw in ws:
            msg = json.loads(raw)
            op = msg.get("op")
            d = msg.get("d", {})
            if op == 7:
                rid = d.get("requestId")
                fut = self._pending.pop(rid, None)
                if fut and not fut.done():
                    fut.set_result(d.get("responseData", {}))
            elif op == 5:
                await _handle_obs_event(d)


async def _handle_obs_event(d: dict) -> None:
    etype = d.get("eventType")
    data = d.get("eventData", {})
    obs = state.data["obs"]

    if etype == "CurrentProgramSceneChanged":
        obs["current_scene"] = data.get("sceneName", "")
    elif etype == "StreamStateChanged":
        obs["streaming"] = data.get("outputActive", False)
    elif etype == "RecordStateChanged":
        obs["recording"] = data.get("outputActive", False)
    elif etype == "InputMuteStateChanged":
        for a in obs["audio"]:
            if a["name"] == data.get("inputName"):
                a["muted"] = data.get("inputMuted", a.get("muted", False))
    elif etype == "InputVolumeChanged":
        for a in obs["audio"]:
            if a["name"] == data.get("inputName"):
                a["volume_db"] = data.get("inputVolumeDb", a.get("volume_db", 0))
    else:
        return

    broadcast_sync({"type": "obs_state", "obs": obs})


async def obs_set_scene_item_visibility(scene_name: str, source_name: str, enabled: bool) -> bool:
    if not source_name or state.obs is None:
        return False

    candidates = []
    if scene_name:
        candidates.append(scene_name)

    
    
    
    
    for known in state.data.get("obs", {}).get("scenes", []):
        if known not in candidates:
            candidates.append(known)

    for candidate in candidates:
        try:
            scene_items = await state.obs.request("GetSceneItemList", {"sceneName": candidate})
            for item in scene_items.get("sceneItems", []):
                if item.get("sourceName") == source_name:
                    await state.obs.request("SetSceneItemEnabled", {
                        "sceneName": candidate,
                        "sceneItemId": item.get("sceneItemId"),
                        "sceneItemEnabled": bool(enabled),
                    })
                    return True
        except Exception:
            continue

    return False


async def obs_set_words_visibility(active: bool) -> None:
    scene_name = (OBS_WORDS_SCENE or state.data["obs"].get("current_scene", "")).strip()
    source_name = OBS_WORDS_SOURCE.strip() or "Words"
    if not source_name:
        return
    await obs_set_scene_item_visibility(scene_name, source_name, active)


def trigger_words_toggle(active: bool) -> None:
    if state.main_loop is None:
        return
    try:
        future = asyncio.run_coroutine_threadsafe(obs_set_words_visibility(active), state.main_loop)
        future.result(timeout=5)
    except Exception:
        pass


async def obs_refresh_all() -> None:
    obs_client = state.obs
    if obs_client is None:
        return
    obs = state.data["obs"]

    scenes_resp = await obs_client.request("GetSceneList")
    obs["scenes"] = [s["sceneName"] for s in scenes_resp.get("scenes", [])]
    obs["current_scene"] = scenes_resp.get("currentProgramSceneName", "")

    stream_resp = await obs_client.request("GetStreamStatus")
    obs["streaming"] = stream_resp.get("outputActive", False)

    record_resp = await obs_client.request("GetRecordStatus")
    obs["recording"] = record_resp.get("outputActive", False)

    inputs_resp = await obs_client.request("GetInputList")
    audio = []
    for inp in inputs_resp.get("inputs", []):
        kind = inp.get("inputKind", "")
        if "audio" not in kind and "mic" not in kind and "input_capture" not in kind:
            continue
        name = inp["inputName"]
        try:
            mute_resp = await obs_client.request("GetInputMute", {"inputName": name})
            vol_resp = await obs_client.request("GetInputVolume", {"inputName": name})
            audio.append({
                "name": name,
                "muted": mute_resp.get("inputMuted", False),
                "volume_db": vol_resp.get("inputVolumeDb", 0),
            })
        except Exception:
            continue
    obs["audio"] = audio

    broadcast_sync({"type": "obs_state", "obs": obs})


async def obs_client_task() -> None:
    while True:
        listen_task = None
        try:
            state.obs = OBSClient(OBS_WS_URL, OBS_WS_PASSWORD)
            await state.obs.connect()
            state.data["obs"]["connected"] = True
            log.info("obs-websocket connected")

            listen_task = asyncio.create_task(state.obs.listen())

            await obs_refresh_all()
            broadcast_sync({"type": "obs_state", "obs": state.data["obs"]})

            await listen_task
        except Exception:
            state.data["obs"]["connected"] = False
            broadcast_sync({"type": "obs_state", "obs": state.data["obs"]})
            state.obs = None
            if listen_task and not listen_task.done():
                listen_task.cancel()
            await asyncio.sleep(5)


async def obs_dispatch(cmd: str, msg: dict) -> None:
    if state.obs is None:
        return
    try:
        if cmd == "obs_set_scene":
            await state.obs.request("SetCurrentProgramScene", {"sceneName": msg.get("value", "")})
        elif cmd == "obs_set_mute":
            await state.obs.request("SetInputMute", {
                "inputName": msg.get("input", ""), "inputMuted": bool(msg.get("muted", False)),
            })
        elif cmd == "obs_toggle_mute":
            await state.obs.request("ToggleInputMute", {"inputName": msg.get("input", "")})
        elif cmd == "obs_set_volume":
            await state.obs.request("SetInputVolume", {
                "inputName": msg.get("input", ""), "inputVolumeDb": float(msg.get("volume_db", 0)),
            })
        elif cmd == "obs_toggle_stream":
            await state.obs.request("ToggleStream")
        elif cmd == "obs_toggle_record":
            await state.obs.request("ToggleRecord")
        elif cmd == "obs_set_scene_item_enabled":
            scene_name = msg.get("scene") or msg.get("sceneName") or state.data["obs"].get("current_scene", "")
            source_name = msg.get("source") or msg.get("sourceName")
            enabled = bool(msg.get("enabled", msg.get("visible", True)))
            item_id = msg.get("sceneItemId")
            if scene_name and item_id is not None:
                await state.obs.request("SetSceneItemEnabled", {
                    "sceneName": scene_name,
                    "sceneItemId": int(item_id),
                    "sceneItemEnabled": enabled,
                })
            elif scene_name and source_name:
                await obs_set_scene_item_visibility(scene_name, source_name, enabled)
        elif cmd == "obs_refresh":
            await obs_refresh_all()
    except Exception:
        pass
