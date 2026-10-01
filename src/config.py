import logging
import os
import pathlib

_BASE_DIR_EARLY = pathlib.Path(os.environ.get("STREAM_BASE_DIR", r"C:\Stream"))
_BASE_DIR_EARLY.mkdir(parents=True, exist_ok=True)
LOG_PATH = _BASE_DIR_EARLY / "streamd.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(str(LOG_PATH), encoding="utf-8"),
    ],
)
log = logging.getLogger("streamd")

WS_PORT = 8877
HTTP_PORT = 8878

BASE_DIR = _BASE_DIR_EARLY





# C:\Stream\overlays location as a final fallback. see http_server.py's

_REPO_OVERLAY_DIR = pathlib.Path(__file__).resolve().parent.parent / "overlay"
OVERLAY_DIR = pathlib.Path(os.environ.get("STREAM_OVERLAY_DIR", r"C:\Stream\overlays"))
OVERLAY_SEARCH_DIRS = []
if os.environ.get("STREAM_OVERLAY_DIR"):
    OVERLAY_SEARCH_DIRS.append(pathlib.Path(os.environ["STREAM_OVERLAY_DIR"]))
OVERLAY_SEARCH_DIRS.append(_REPO_OVERLAY_DIR)
if pathlib.Path(r"C:\Stream\overlays") not in OVERLAY_SEARCH_DIRS:
    OVERLAY_SEARCH_DIRS.append(pathlib.Path(r"C:\Stream\overlays"))

PNGTUBER_DIR = pathlib.Path(os.environ.get("STREAM_PNGTUBER_DIR", r"C:\Stream\pngtuber"))
PNGTUBER_DIR.mkdir(parents=True, exist_ok=True)


def _load_dotenv(path: pathlib.Path) -> None:
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception as e:
        log.warning("[env] failed to read %s: %s", path, e)


_load_dotenv(pathlib.Path(__file__).resolve().parent / ".env")
_load_dotenv(BASE_DIR / ".env")

PNGTUBER_STATES = [
    "neutral", "speaking", "generating", "playing",
    "chatting", "bored", "sad", "cheerful",
]
for _s in PNGTUBER_STATES:
    (PNGTUBER_DIR / _s).mkdir(parents=True, exist_ok=True)

NICK = os.environ.get("TWITCH_BROADCASTER", "")
PASS = os.environ.get("TWITCH_OAUTH", "")
CHAN = "#" + NICK

MAX_CHAT_LINES = 20
STATS_INTERVAL = 10
MUSIC_INTERVAL = 2
TYPEWRITER_DELAY = 0.04

COMMANDS_PATH = BASE_DIR / "commands.json"
REWARDS_PATH = BASE_DIR / "rewards.json"
CHECKINS_PATH = BASE_DIR / "checkins.json"
DEATHS_PATH = BASE_DIR / "deaths.json"
CANVAS_PATH = BASE_DIR / "canvas.json"
LAYOUTS_DIR = pathlib.Path(os.environ.get("STREAM_LAYOUTS_DIR", str(BASE_DIR / "layouts")))
LAYOUTS_DIR.mkdir(parents=True, exist_ok=True)
REDEEMS_DIR = pathlib.Path(os.environ.get("STREAM_REDEEMS_DIR", str(BASE_DIR / "redeems")))
REDEEMS_DIR.mkdir(parents=True, exist_ok=True)

OBS_WS_URL = os.environ.get("OBS_WS_URL", "ws://127.0.0.1:4455")
OBS_WS_PASSWORD = os.environ.get("OBS_WS_PASSWORD", "")
OBS_WORDS_SCENE = os.environ.get("OBS_WORDS_SCENE", "").strip()
OBS_WORDS_SOURCE = os.environ.get("OBS_WORDS_SOURCE", "Words").strip() or "Words"

TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.environ.get("TWITCH_CLIENT_SECRET", "")
TWITCH_OAUTH_TOKEN = PASS.replace("oauth:", "")
TWITCH_BROADCASTER = NICK
TWITCH_STATS_INTERVAL = 60
TWITCH_USER_TOKEN = os.environ.get("TWITCH_USER_TOKEN", "").replace("oauth:", "")

TWITCH_TOKEN_PATH = BASE_DIR / "twitch_token.json"
TWITCH_AUTH_REDIRECT_URI = os.environ.get("TWITCH_AUTH_REDIRECT_URI", "http://localhost:1752/callback")
TWITCH_AUTH_PORT = int(os.environ.get("TWITCH_AUTH_PORT", "1752"))
TWITCH_AUTH_SCOPES = (
    "chat:read "
    "chat:edit "
    "moderator:read:followers "
    "channel:read:redemptions "
    "channel:read:subscriptions "
    "bits:read "
    "channel:manage:broadcast "
    "channel:read:ads "
    "channel:manage:ads"
)

DISCORD_CLIENT_ID = os.environ.get("DISCORD_CLIENT_ID", "")

raw_tts = os.environ.get("TTS_ENABLED", "True")
TTS_ENABLED_DEFAULT = str(raw_tts).strip().lower() in ("true", "1", "yes", "t")
TTS_VOICE_PATH = os.environ.get("TTS_VOICE_PATH", r"")
TTS_DEVICE = os.environ.get("TTS_DEVICE", "cpu")
TTS_OUTPUT_DEVICE = 19

TTS_ONNX_MODEL_DIR = os.environ.get("TTS_ONNX_MODEL_DIR", r"")
TTS_ONNX_DTYPE = os.environ.get("TTS_ONNX_DTYPE", "q4f16")
TTS_ONNX_PROVIDER = os.environ.get("TTS_ONNX_PROVIDER", "cpu")
TTS_MAX_NEW_TOKENS = int(os.environ.get("TTS_MAX_NEW_TOKENS", "512"))
TTS_TEMPERATURE = float(os.environ.get("TTS_TEMPERATURE", "0.5"))
TTS_TOP_K = int(os.environ.get("TTS_TOP_K", "50"))
TTS_TOP_P = float(os.environ.get("TTS_TOP_P", "0.9"))
TTS_REPETITION_PENALTY = float(os.environ.get("TTS_REPETITION_PENALTY", "1.2"))
TTS_GREEDY = str(os.environ.get("TTS_GREEDY", "False")).strip().lower() in ("true", "1", "yes", "t")

TTS_VOICES_DIR = pathlib.Path(os.environ.get("TTS_VOICES_DIR", str(BASE_DIR / "voices")))
TTS_VOICES_DIR.mkdir(parents=True, exist_ok=True)
TTS_VOICE_EXTS = (".wav", ".mp3", ".flac", ".ogg")

MEDIA_DIR = pathlib.Path(os.environ.get("STREAM_MEDIA_DIR", str(REDEEMS_DIR / "media")))
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_EXTS = (".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg")

AD_REMINDER_ENABLED = str(os.environ.get("AD_REMINDER_ENABLED", "True")).strip().lower() in ("true", "1", "yes", "t")
AD_REMINDER_WARN_SECONDS = int(os.environ.get("AD_REMINDER_WARN_SECONDS", "120"))
AD_SCHEDULE_POLL_INTERVAL = int(os.environ.get("AD_SCHEDULE_POLL_INTERVAL", "30"))
AD_REMINDER_WARN_MESSAGE = os.environ.get(
    "AD_REMINDER_WARN_MESSAGE", ""
)
AD_REMINDER_START_MESSAGE = os.environ.get(
    "AD_REMINDER_START_MESSAGE", ""
)
AD_REMINDER_END_MESSAGE = os.environ.get(
    "AD_REMINDER_END_MESSAGE", ""
)


WOS_URL = os.environ.get("WOS_URL", "https://wos.gg/")


CANVAS_SIZE = int(os.environ.get("CANVAS_SIZE", "20"))
CANVAS_PUBLIC_PORT = int(os.environ.get("CANVAS_PUBLIC_PORT", "1760"))
CANVAS_PUBLIC_BASE_URL = os.environ.get("CANVAS_PUBLIC_BASE_URL", f"http://localhost:{CANVAS_PUBLIC_PORT}")
CANVAS_PUBLIC_COOKIE = "streamd_canvas_session"
CANVAS_PUBLIC_REDIRECT_PATH = "/canvas/callback"
CANVAS_PUBLIC_REDIRECT_URI = os.environ.get("CANVAS_PUBLIC_REDIRECT_URI", CANVAS_PUBLIC_BASE_URL.rstrip("/") + CANVAS_PUBLIC_REDIRECT_PATH)
CANVAS_PUBLIC_TWITCH_SCOPE = "user:read:email"
CANVAS_SHOW_SECONDS = int(os.environ.get("CANVAS_SHOW_SECONDS", "5"))
CANVAS_MIN_INTERVAL_MIN = int(os.environ.get("CANVAS_MIN_INTERVAL_MIN", "30"))
CANVAS_MAX_INTERVAL_MIN = int(os.environ.get("CANVAS_MAX_INTERVAL_MIN", "60"))
CANVAS_PIXELS_REDEEM_SMALL = int(os.environ.get("CANVAS_PIXELS_REDEEM_SMALL", "1"))
CANVAS_PIXELS_REDEEM_LARGE = int(os.environ.get("CANVAS_PIXELS_REDEEM_LARGE", "10"))
CANVAS_PIXELS_PER_GIFT = int(os.environ.get("CANVAS_PIXELS_PER_GIFT", "10"))
CANVAS_PIXELS_PER_SUB = int(os.environ.get("CANVAS_PIXELS_PER_SUB", "10"))
CANVAS_PIXELS_PER_100_BITS = int(os.environ.get("CANVAS_PIXELS_PER_100_BITS", "1"))

HF_TOKEN = os.environ.get("HF_TOKEN", "") or os.environ.get("HUGGINGFACE_TOKEN", "")
if HF_TOKEN:
    os.environ.setdefault("HF_TOKEN", HF_TOKEN)
    os.environ.setdefault("HUGGING_FACE_HUB_TOKEN", HF_TOKEN)



YTM_COMPANION_HOST = os.environ.get("YTM_COMPANION_HOST", "127.0.0.1")
YTM_COMPANION_PORT = int(os.environ.get("YTM_COMPANION_PORT", "9863"))

# then reused. This is pear-desktop's companion-server API token, NOT your

YTM_COMPANION_TOKEN_PATH = BASE_DIR / "ytm_companion_token.json"
YTM_COMPANION_APP_ID = os.environ.get("YTM_COMPANION_APP_ID", "streamd")





# not through ytmusicapi (ytmusicapi has no live "now playing" concept).
YTM_AUTH_HEADERS_PATH = pathlib.Path(
    os.environ.get("YTM_AUTH_HEADERS_PATH", str(BASE_DIR / "ytm_headers_auth.json"))
)


MV_CACHE_DIR = pathlib.Path(os.environ.get("STREAM_MV_CACHE_DIR", str(BASE_DIR / "mv_cache")))
MV_CACHE_DIR.mkdir(parents=True, exist_ok=True)
MV_MAX_CACHE_BYTES = int(os.environ.get("MV_MAX_CACHE_BYTES", str(5 * 1024 * 1024 * 1024)))  
MV_DOWNLOAD_ENABLED = str(os.environ.get("MV_DOWNLOAD_ENABLED", "True")).strip().lower() in ("true", "1", "yes", "t")


try:
    import onnxruntime as onnxruntime_preloaded
except Exception:
    onnxruntime_preloaded = None