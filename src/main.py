import asyncio
import sys
import threading
import time

import websockets

from config import log, WS_PORT, BASE_DIR, LOG_PATH, PNGTUBER_DIR
from state import state
from commands import load_commands
from redeems import load_rewards, load_checkins
from flags import load_flags
from obs import obs_client_task
from twitch_api import run_twitch_stats_thread, run_ad_schedule_thread, twitch_eventsub_loop
from twitch_auth import get_twitch_user_token, run_twitch_auth_flow
from discord_rpc import run_discord_rpc_thread
from tts import run_tts_worker, run_hotkeys
from chat_irc import run_stats_thread, run_music_thread, run_chat_thread, run_wpm_tracker
from http_server import start_http_server
from ws_handler import ws_handler

state.data["commands"] = load_commands()
state.data["rewards"] = load_rewards()
state.data["checkins"] = load_checkins()
state.data["flags"] = load_flags()


def run_twitch_token_refresh_thread() -> None:
    while True:
        try:
            get_twitch_user_token() 
        except Exception as e:
            log.warning("[twitch-auth] background refresh check failed: %s", e)
        time.sleep(300)


async def main() -> None:
    state.main_loop = asyncio.get_running_loop()

    log.info("starting — ws://localhost:%d", WS_PORT)
    log.info("base dir: %s", BASE_DIR)
    log.info("log: %s", LOG_PATH)
    log.info("pngtuber dir: %s (set STREAM_PNGTUBER_DIR to override)", PNGTUBER_DIR)

    for target in (run_stats_thread, run_music_thread, run_chat_thread, run_wpm_tracker,
                   run_tts_worker, run_hotkeys, run_twitch_stats_thread, run_discord_rpc_thread,
                   run_twitch_token_refresh_thread, run_ad_schedule_thread):
        threading.Thread(target=target, daemon=True, name=target.__name__).start()

    threading.Thread(target=start_http_server, daemon=True, name="http").start()

    asyncio.create_task(obs_client_task())
    asyncio.create_task(twitch_eventsub_loop())

    async with websockets.serve(ws_handler, "localhost", WS_PORT):
        log.info("ready.")
        await asyncio.Future()


if __name__ == "__main__":
    if "--auth" in sys.argv:
        run_twitch_auth_flow()
    else:
        asyncio.run(main())
