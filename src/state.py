import asyncio
import threading
from collections import deque
from typing import TYPE_CHECKING

from config import TTS_ENABLED_DEFAULT, AD_REMINDER_ENABLED, CANVAS_SIZE

if TYPE_CHECKING:
    from obs import OBSClient


class StreamState:
    """Central mutable state shared by every module, mirroring the
    original script's module-level globals. One instance (`state`,
    below) is imported everywhere."""

    def __init__(self) -> None:
        self.main_loop: asyncio.AbstractEventLoop | None = None

        self.clients: set = set()
        self.clients_lock = threading.Lock()

        self.data: dict = {
            "status": "starting soon",
            "message": "",
            "music": {"title": "—", "artist": "—", "playing": False,
                      "duration": 0, "position": 0, "video_url": None},
            "chat": [],
            "stats": {"cpu": "…", "mem": "…", "gpu": "…", "wpm": "…", "uptime": "…"},
            "scene": "live",
            "commands": {},
            "extra": "",
            "obs": {
                "connected": False,
                "scenes": [],
                "current_scene": "",
                "streaming": False,
                "recording": False,
                "audio": [],
            },
            "tts": {
                "enabled": TTS_ENABLED_DEFAULT,
                "loading": True,
                "ready": False,
                "generating": False,
                "speaking": False,
                "queue_len": 0,
                "current": "",
                "voice": "default",
                "voices": [],
            },
            "twitch": {
                "connected": False,
                "followers": None,
                "subscribers": None,
                "viewers": None,
                "live": False,
                "title": "",
                "game_id": "",
                "game_name": "",
                "tags": [],
            },
            "discord": {
                "connected": False,
            },
            "schedule": {
                "scheduled_today": False,
                "offline_text": "",
            },
            "pngtuber": {
                "mood": "neutral",
            },
            "wm_layout": [],
            "wm_layouts": {},
            "notepads": {},
            "latest": {"follower": "", "sub": ""},
            "layouts": {"active": "default", "names": []},
            "rewards": {},
            "redeem_log": [],
            "checkins": {},
            "deaths": {},
            "flags": {},
            "ads": {
                "enabled": AD_REMINDER_ENABLED,
                "next_ad_at": "",
                "duration": 0,
                "warned": False,
                "in_ad_break": False,
                "seconds_until": None,
            },
            "words": {
                "active": False,
            },
            "key_panel": {
                "shape": "round",
                "size": 48,
                "gap": 8,
                "glow": True,
                "border": False,
                "border_color": "#ffffff",
                "border_width": 1,
                "corner_radius": None,
                "active_color": "#7ef7c6",
                "inactive_color": "#1f2731",
                "text_color": "#f5f7fa",
                "keys": [
                    {"key": "w", "label": "W", "shape": "round", "color": "#7ef7c6", "active": False},
                    {"key": "a", "label": "A", "shape": "square", "color": "#7ef7c6", "active": False},
                    {"key": "s", "label": "S", "shape": "square", "color": "#7ef7c6", "active": False},
                    {"key": "d", "label": "D", "shape": "square", "color": "#7ef7c6", "active": False},
                    {"key": "space", "label": "SPACE", "shape": "pill", "color": "#8be9fd", "active": False},
                ],
                "active_keys": [],
            },
            "canvas": {
                "size": CANVAS_SIZE,
                "visible": False,
                "pixels": {},  # "x,y" -> "#rrggbb"
                "owners": {},  # "x,y" -> "lowercase twitch username"
            },
        }

        self.wpm_lock = threading.Lock()
        self.keypress_times: deque = deque()

        self.irc_socket = None
        self.media_session = None

        # obs client (obs.py)
        self.obs: "OBSClient | None" = None

        # twitch auth (twitch_auth.py)
        self.twitch_token_lock = threading.Lock()
        self.twitch_token_state: dict = {}
        self.twitch_user_id = None
        self.twitch_app_token = ""
        self.twitch_authorizing_user_id = None
        self.channel_info_lock = threading.Lock()
        self.base_stream_title: str | None = None

        # tts (tts.py)
        self.tts_queue = None
        self.tts_sessions = None
        self.tts_tokenizer = None
        self.tts_lock = threading.Lock()
        self.tts_popup_open = threading.Lock()

        # redeems (redeems.py)
        self.first_chatter_today: str | None = None
        self.first_chatter_date: str = ""

        # commands (commands.py)
        self.cooldowns: dict = {}
        self.counters: dict = {}

        # canvas (canvas.py)
        self.canvas_lock = threading.Lock()
        self.canvas_credits: dict = {}  # username.lower() -> pending pixel credits
        self.canvas_public_sessions: dict[str, dict] = {}

    def tts_state(self) -> dict:
        return self.data["tts"]


state = StreamState()