import http.server
import json
import socketserver
import time
import urllib.error
import urllib.parse

from config import (
    log, TWITCH_TOKEN_PATH, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
    TWITCH_USER_TOKEN, TWITCH_AUTH_REDIRECT_URI, TWITCH_AUTH_PORT, TWITCH_AUTH_SCOPES,
)
from state import state


def load_twitch_token() -> dict:
    if TWITCH_TOKEN_PATH.exists():
        try:
            return json.loads(TWITCH_TOKEN_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning("[twitch-auth] failed to read %s: %s", TWITCH_TOKEN_PATH, e)
    return {}


def save_twitch_token(data: dict) -> None:
    import os
    try:
        TWITCH_TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        try:
            os.chmod(TWITCH_TOKEN_PATH, 0o600)
        except Exception:
            pass
    except Exception as e:
        log.warning("[twitch-auth] failed to save %s: %s", TWITCH_TOKEN_PATH, e)


def twitch_token_exchange(payload: dict) -> dict:
    import urllib.request

    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"twitch token endpoint returned {e.code}: {detail}") from e


def refresh_twitch_user_token() -> str | None:
    """exchanges the stored refresh_token for a new access_token. returns
    the new access token, or None if there's nothing to refresh with."""
    with state.twitch_token_lock:
        tstate = state.twitch_token_state or load_twitch_token()
        refresh_token = tstate.get("refresh_token")
        if not refresh_token or not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            return None
        try:
            data = twitch_token_exchange({
                "client_id": TWITCH_CLIENT_ID,
                "client_secret": TWITCH_CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            })
        except Exception as e:
            log.warning("[twitch-auth] refresh failed: %s", e)
            return None

        access_token = data.get("access_token")
        if not access_token:
            log.warning("[twitch-auth] refresh response missing access_token: %s", data)
            return None

        new_state = {
            "access_token": access_token,
            "refresh_token": data.get("refresh_token", refresh_token),
            "expires_at": time.time() + float(data.get("expires_in", 3600)) - 60,
        }
        state.twitch_token_state.clear()
        state.twitch_token_state.update(new_state)
        save_twitch_token(new_state)
        log.info("[twitch-auth] refreshed user token, valid ~%ds", data.get("expires_in", 0))
        return access_token


def get_twitch_user_token() -> str:
    """the single source of truth for the current user-token access token."""
    if not state.twitch_token_state:
        state.twitch_token_state = load_twitch_token()
        if not state.twitch_token_state and TWITCH_USER_TOKEN:
            state.twitch_token_state = {"access_token": TWITCH_USER_TOKEN, "refresh_token": None, "expires_at": 0}

    refresh_token = state.twitch_token_state.get("refresh_token")
    expires_at = state.twitch_token_state.get("expires_at", 0)
    if refresh_token and time.time() >= expires_at:
        refreshed = refresh_twitch_user_token()
        if refreshed:
            return refreshed

    return state.twitch_token_state.get("access_token", TWITCH_USER_TOKEN)


class _TwitchAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    auth_code: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        if "code" in params:
            _TwitchAuthCallbackHandler.auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Authorization successful!</h1><p>You can close this tab.</p>")
        else:
            self.send_response(400)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Authorization failed.</h1><p>No code returned.</p>")

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def run_twitch_auth_flow() -> None:
    """interactive one-time setup: `python main.py --auth`."""
    import webbrowser

    if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
        print("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set (env vars) before running --auth.")
        return

    auth_url = (
        "https://id.twitch.tv/oauth2/authorize"
        f"?client_id={TWITCH_CLIENT_ID}"
        f"&redirect_uri={urllib.parse.quote(TWITCH_AUTH_REDIRECT_URI)}"
        "&response_type=code"
        f"&scope={urllib.parse.quote(TWITCH_AUTH_SCOPES)}"
    )

    print("Opening browser for Twitch authorization...")
    print(f"If it doesn't open automatically, visit:\n{auth_url}\n")
    webbrowser.open(auth_url)

    _TwitchAuthCallbackHandler.auth_code = None
    with socketserver.TCPServer(("", TWITCH_AUTH_PORT), _TwitchAuthCallbackHandler) as httpd:
        httpd.handle_request()

    code = _TwitchAuthCallbackHandler.auth_code
    if not code:
        print("Did not receive an authorization code. Aborting.")
        return

    try:
        data = twitch_token_exchange({
            "client_id": TWITCH_CLIENT_ID,
            "client_secret": TWITCH_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": TWITCH_AUTH_REDIRECT_URI,
        })
    except Exception as e:
        print(f"Token exchange failed: {e}")
        return

    if "access_token" not in data:
        print(f"Token exchange did not return an access token: {data}")
        return

    new_state = {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token"),
        "expires_at": time.time() + float(data.get("expires_in", 3600)) - 60,
    }
    save_twitch_token(new_state)
    print("\n--- AUTHORIZATION SUCCESSFUL ---")
    print(f"Scopes granted: {data.get('scope')}")
    print(f"Token saved to: {TWITCH_TOKEN_PATH}")
    print("The daemon will keep this refreshed automatically from now on.")
