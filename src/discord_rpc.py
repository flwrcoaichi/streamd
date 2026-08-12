import time

from config import log, DISCORD_CLIENT_ID
from state import state


def run_discord_rpc_thread() -> None:
    try:
        from pypresence import Presence
        from pypresence.types import ActivityType, StatusDisplayType
    except ImportError:
        log.info("[discord] pypresence not installed — pip install pypresence")
        return

    if not DISCORD_CLIENT_ID:
        log.info("[discord] DISCORD_CLIENT_ID not set, rich presence disabled")
        return

    rpc = None
    last_key = None
    start_ts = int(time.time())

    while True:
        try:
            if rpc is None:
                rpc = Presence(DISCORD_CLIENT_ID)
                rpc.connect()
                state.data["discord"]["connected"] = True
                log.info("[discord] rich presence connected")

            live = state.data.get("twitch", {}).get("live", False)
            status = state.data.get("status", "")
            schedule = state.data.get("schedule", {})
            scheduled = schedule.get("scheduled_today", False)
            offline_text = schedule.get("offline_text", "").strip()

            if live:
                image, text, details = "live", status or "streaming", None
            elif scheduled:
                image, text, details = "scheduled", offline_text or "stream scheduled today", None
            elif offline_text:
                image, text, details = "offline", offline_text, None
            else:
                image, text, details = "unscheduled", "no stream scheduled", None

            key = (image, text)
            if key != last_key:
                last_key = key
                start_ts = int(time.time())

            rpc.update(
                activity_type=ActivityType.WATCHING,
                state=text,
                details=details,
                start=start_ts,
                large_text="vanillynBot",
                large_image=image,
            )
        except Exception as e:
            log.warning("[discord] rpc update failed: %s", e)
            state.data["discord"]["connected"] = False
            rpc = None

        time.sleep(15)
