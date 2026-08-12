#!/usr/bin/env python3
"""
streamd: a daemon for managing a Twitch stream with overlays, a simple bot, a websocket api, and tts.
usage:
    python main.py            # run the daemon
    python main.py --auth     # authorize with your twitch account to get a user and refresh token
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "src"))

from main import main, run_twitch_auth_flow
import asyncio

if __name__ == "__main__":
    if "--auth" in sys.argv:
        run_twitch_auth_flow()
    else:
        asyncio.run(main())