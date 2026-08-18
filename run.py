#!/usr/bin/env python3
"""
streamd: a daemon for managing a Twitch stream with overlays, a simple bot, a websocket api, and tts.
usage:
    python run.py             # run the daemon
    python run.py --auth      # authorize with your twitch account to get a user and refresh token
    python run.py --ytm-auth  # pair with pear-desktop's companion API for YouTube Music control
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "src"))

from main import main, run_twitch_auth_flow
from ytmusic_bridge import run_companion_pairing_flow
import asyncio

if __name__ == "__main__":
    if "--auth" in sys.argv:
        run_twitch_auth_flow()
    elif "--ytm-auth" in sys.argv:
        run_companion_pairing_flow()
    else:
        asyncio.run(main())
