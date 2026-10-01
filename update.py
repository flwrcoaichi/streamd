import pathlib, re, sys

R = pathlib.Path(__file__).resolve().parent
OUT = {}


def rd(rel):
    if rel in OUT:
        return OUT[rel][0], OUT[rel][1]
    raw = (R / rel).read_bytes().decode('utf-8')
    return raw.replace('\r\n', '\n'), '\r\n' in raw


def ed(rel, pairs):
    s, crlf = rd(rel)
    for p in pairs:
        if callable(p):
            s = p(s)
            continue
        a, b = p[0], p[1]
        n = p[2] if len(p) > 2 else 1
        if s.count(a) != n:
            sys.exit(f'{rel}: expected {n} match(es), got {s.count(a)} for: {a[:80]!r}')
        s = s.replace(a, b)
    OUT[rel] = (s, crlf)


def new(rel, text):
    OUT[rel] = (text, False)


def rx(pattern, repl):
    def f(s):
        out, n = re.subn(pattern, lambda m: repl, s, flags=re.S)
        if n != 1:
            sys.exit(f'regex matched {n} times: {pattern[:60]}')
        return out
    return f


# ───────────────────────── config / env ─────────────────────────
ed('src/config.py', [
    ('TWITCH_AUTH_REDIRECT_URI = "http://localhost:1752/callback"\nTWITCH_AUTH_PORT = 1752',
     'TWITCH_AUTH_REDIRECT_URI = os.environ.get("TWITCH_AUTH_REDIRECT_URI", "http://localhost:1752/callback")\nTWITCH_AUTH_PORT = int(os.environ.get("TWITCH_AUTH_PORT", "1752"))'),
    ('CANVAS_PUBLIC_REDIRECT_PATH = "/canvas/callback"',
     'CANVAS_PUBLIC_REDIRECT_PATH = "/canvas/callback"\nCANVAS_PUBLIC_REDIRECT_URI = os.environ.get("CANVAS_PUBLIC_REDIRECT_URI", CANVAS_PUBLIC_BASE_URL.rstrip("/") + CANVAS_PUBLIC_REDIRECT_PATH)'),
])

ed('.env.example', [
    lambda s: s.rstrip('\n') + r'''

# TWITCH OAUTH REDIRECTS (must match the redirect URLs registered in the Twitch dev console)
TWITCH_AUTH_REDIRECT_URI   = http://localhost:1752/callback
TWITCH_AUTH_PORT           = 1752

# PUBLIC CANVAS
CANVAS_PUBLIC_PORT         = 1760
CANVAS_PUBLIC_BASE_URL     = http://localhost:1760
CANVAS_PUBLIC_REDIRECT_URI = http://localhost:1760/canvas/callback
''',
])

# ───────────────────────── canvas public page ─────────────────────────
new('overlay/canvas-public.html', r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>canvas</title>
<style>
:root{color-scheme:dark;--ink:#e8edf1;--bg:#0a0c0d}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:'Courier New',ui-monospace,monospace;overflow:hidden}
body{display:grid;place-items:center}
#bar{position:fixed;top:12px;right:12px;display:flex;gap:10px;align-items:center;z-index:5}
#auth{font:inherit;color:var(--ink);background:none;border:1px solid var(--ink);padding:6px 12px;cursor:pointer;text-transform:lowercase;transition:background .15s,color .15s}
#auth:hover{background:var(--ink);color:var(--bg)}
#color{width:34px;height:34px;padding:0;border:1px solid var(--ink);background:none;cursor:pointer}
#wrap{position:relative;width:min(86vmin,900px);aspect-ratio:1;border:1px solid var(--ink);animation:in .5s ease both}
@keyframes in{from{opacity:0;transform:scale(.96)}}
#c{display:block;width:100%;height:100%;image-rendering:pixelated;cursor:none;background:#11161d;touch-action:none}
#ghost{position:absolute;left:0;top:0;pointer-events:none;opacity:0;outline:1px solid #fff;transition:transform .07s ease-out,opacity .15s;z-index:2}
#ghost.on{opacity:.75}
#carry{position:fixed;left:0;top:0;width:14px;height:14px;border:1px solid #fff;pointer-events:none;opacity:0;z-index:9;box-shadow:0 4px 10px rgba(0,0,0,.6);transition:opacity .15s,transform .06s ease-out}
#carry.on{opacity:1}
.pop{position:absolute;pointer-events:none;border:2px solid currentColor;animation:pop .45s ease-out forwards}
@keyframes pop{to{transform:scale(5);opacity:0}}
</style>
</head>
<body>
<div id="bar"><input id="color" type="color" value="#ff7a18" aria-label="color"><button id="auth" type="button">sign in with twitch</button></div>
<div id="wrap"><canvas id="c"></canvas><div id="ghost"></div></div>
<div id="carry"></div>
<script>
const $=id=>document.getElementById(id),c=$('c'),x=c.getContext('2d'),wrap=$('wrap'),ghost=$('ghost'),carry=$('carry'),color=$('color'),auth=$('auth');
let size=100,pixels={},user=null;
const api=async(u,o)=>{const r=await fetch(u,o);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'failed');return d};
function draw(){c.width=c.height=size;x.fillStyle='#11161d';x.fillRect(0,0,size,size);for(const k in pixels){const[a,b]=k.split(',');x.fillStyle=pixels[k];x.fillRect(+a,+b,1,1)}}
async function board(){try{const d=await api('/canvas/state');size=d.size||100;pixels=d.pixels||{};draw();ghost.style.width=ghost.style.height=100/size+'%'}catch(e){}}
async function session(){try{user=(await api('/canvas/session')).username||null}catch(e){user=null}auth.textContent=user||'sign in with twitch';auth.title=user?'click to sign out':''}
auth.onclick=async()=>{if(!user){location.href='/canvas/login';return}await api('/canvas/logout',{method:'POST'}).catch(()=>{});user=null;await session()};
function paint(){ghost.style.background=color.value;carry.style.background=color.value}
color.oninput=paint;
function at(e){const r=c.getBoundingClientRect();const px=Math.floor((e.clientX-r.left)/r.width*size),py=Math.floor((e.clientY-r.top)/r.height*size);return px>=0&&py>=0&&px<size&&py<size?[px,py]:null}
function move(e){carry.style.transform=`translate(${e.clientX+12}px,${e.clientY+12}px)`;const p=at(e);ghost.classList.toggle('on',!!p);carry.classList.toggle('on',!!p);if(p)ghost.style.transform=`translate(${p[0]*100}%,${p[1]*100}%)`}
c.addEventListener('pointermove',move);
c.addEventListener('pointerdown',move);
c.addEventListener('pointerleave',()=>{ghost.classList.remove('on');carry.classList.remove('on')});
function ring(px,py,col){const d=document.createElement('div');d.className='pop';d.style.cssText=`width:${100/size}%;height:${100/size}%;left:${px*100/size}%;top:${py*100/size}%;color:${col}`;wrap.appendChild(d);setTimeout(()=>d.remove(),500)}
c.addEventListener('click',async e=>{
  const p=at(e);if(!p)return;
  if(!user){auth.animate([{transform:'translateX(-4px)'},{transform:'translateX(4px)'},{transform:'none'}],{duration:200,iterations:2});return}
  const[px,py]=p,col=color.value;
  pixels[px+','+py]=col;x.fillStyle=col;x.fillRect(px,py,1,1);ring(px,py,col);
  carry.animate([{scale:'1.8'},{scale:'1'}],{duration:180});
  try{await api('/canvas/place',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:px,y:py,color:col})})}catch(err){board()}
});
paint();session().then(board);setInterval(board,4000);
</script>
</body>
</html>
''')

ed('src/http_server.py', [
    ('CANVAS_PUBLIC_REDIRECT_PATH, CANVAS_PUBLIC_TWITCH_SCOPE,', 'CANVAS_PUBLIC_REDIRECT_URI, CANVAS_PUBLIC_TWITCH_SCOPE,'),
    ('f"{CANVAS_PUBLIC_BASE_URL}{CANVAS_PUBLIC_REDIRECT_PATH}"', 'CANVAS_PUBLIC_REDIRECT_URI', 2),
    rx(r'class CanvasPublicPageHandler.*?(?=class CanvasPublicLoginHandler)', r'''class CanvasPublicPageHandler(tornado.web.RequestHandler):
    def get(self) -> None:
        path = _resolve_overlay_file("canvas-public.html")
        if path is None:
            self.set_status(404)
            self.write("canvas-public.html not found in overlay dirs")
            return
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.write(path.read_text(encoding="utf-8"))


'''),
    ('class LayoutsListHandler(tornado.web.RequestHandler):', r'''class CanvasPublicLogoutHandler(tornado.web.RequestHandler):
    def post(self) -> None:
        state.canvas_public_sessions.pop(self.get_cookie(CANVAS_PUBLIC_COOKIE), None)
        self.clear_cookie(CANVAS_PUBLIC_COOKIE)
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"ok": True}))


class LayoutsListHandler(tornado.web.RequestHandler):'''),
    ('(r"/canvas/place", CanvasPublicPlaceHandler),', '(r"/canvas/place", CanvasPublicPlaceHandler),\n        (r"/canvas/logout", CanvasPublicLogoutHandler),'),
])

# ───────────────────────── server state ─────────────────────────
ed('src/state.py', [
    ('"wm_layout": [],', '"wm_layout": [],\n            "wm_layouts": {},\n            "notepads": {},\n            "latest": {"follower": "", "sub": ""},'),
])

new('src/latest.py', r'''import json

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
''')

ed('src/twitch_api.py', [
    ('from twitch_auth import get_twitch_user_token', 'from twitch_auth import get_twitch_user_token\nfrom latest import set_latest'),
    ('''                followers = _helix_get_user(
                    "https://api.twitch.tv/helix/channels/followers",
                    {"broadcaster_id": uid, "first": 1},
                ).get("total")''',
     '''                fdata = _helix_get_user(
                    "https://api.twitch.tv/helix/channels/followers",
                    {"broadcaster_id": uid, "first": 1},
                )
                followers = fdata.get("total")
                if not state.data["latest"].get("follower") and fdata.get("data"):
                    set_latest("follower", fdata["data"][0].get("user_name"))'''),
    ('broadcast_sync({"type": "follow", "user": event.get("user_name", "someone")})',
     'set_latest("follower", event.get("user_name"))\n                        broadcast_sync({"type": "follow", "user": event.get("user_name", "someone")})'),
    ('elif sub_type == "channel.subscribe":\n',
     'elif sub_type == "channel.subscribe":\n                        set_latest("sub", event.get("user_name") or event.get("user_login"))\n'),
    ('months = event.get("cumulative_months", 0)\n',
     'months = event.get("cumulative_months", 0)\n                        set_latest("sub", user)\n'),
])

ed('src/ws_handler.py', [
    ('async def ws_handler(ws) -> None:', r'''WM_STATE_PATH = BASE_DIR / "wm_state.json"
NOTEPADS_PATH = BASE_DIR / "notepads.json"


def _overlay_name(name: object) -> str:
    return re.sub(r"[^\w\-]", "_", str(name or "main").strip())[:40] or "main"


def load_wm_layouts() -> dict:
    try:
        data = json.loads(WM_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    layouts = data.get("wm_layouts")
    if not isinstance(layouts, dict):
        layouts = {"main": data.get("wm_layout") or []}
    return layouts


def save_wm_layouts() -> None:
    write_atomic(WM_STATE_PATH, json.dumps({"wm_layouts": state.data["wm_layouts"]}, indent=2))


def load_notepads() -> dict:
    try:
        data = json.loads(NOTEPADS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


async def ws_handler(ws) -> None:'''),
    rx(r'                elif cmd == "wm_layout_set":.*?await broadcast\(\{"type": "wm_layout", "layout": layout\}\)\n', r'''                elif cmd == "wm_layout_set":
                    layout = msg.get("layout", [])
                    if isinstance(layout, list):
                        name = _overlay_name(msg.get("name"))
                        state.data["wm_layouts"][name] = layout
                        if name == "main":
                            state.data["wm_layout"] = layout
                        save_wm_layouts()
                        await broadcast({"type": "wm_layout", "name": name, "layout": layout})
                elif cmd == "wm_layout_delete":
                    name = _overlay_name(msg.get("name"))
                    if name != "main" and state.data["wm_layouts"].pop(name, None) is not None:
                        save_wm_layouts()
                        await broadcast({"type": "wm_layout_deleted", "name": name})
                elif cmd == "notepad_set":
                    pid = str(msg.get("id", ""))[:60]
                    if pid:
                        state.data["notepads"][pid] = str(val)[:20000]
                        write_atomic(NOTEPADS_PATH, json.dumps(state.data["notepads"]))
                        await broadcast({"type": "notepad", "id": pid, "value": state.data["notepads"][pid]})
'''),
])

ed('src/main.py', [
    ('from ws_handler import ws_handler, run_key_panel_listener',
     'from ws_handler import ws_handler, run_key_panel_listener, load_wm_layouts, load_notepads\nfrom latest import load_latest'),
    ('state.data["flags"] = load_flags()',
     'state.data["flags"] = load_flags()\nstate.data["wm_layouts"] = load_wm_layouts()\nstate.data["wm_layout"] = state.data["wm_layouts"].get("main", [])\nstate.data["notepads"] = load_notepads()\nstate.data["latest"] = load_latest()'),
])

# ───────────────────────── wm.js: border colors + pixel borders ─────────────────────────
ed('overlay/wm.js', [
    ('  function applyGeometry(win, rec) {', r'''  function hexRgb(h) {
    h = (h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return isNaN(n) || h.length !== 6 ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  let bRaf = null, bLast = 0;
  function startBorderLoop() {
    if (bRaf) return;
    const tick = (ts) => {
      bRaf = requestAnimationFrame(tick);
      if (ts - bLast < 70) return;
      bLast = ts;
      let any = false;
      els.forEach((rec, id) => {
        if (!rec.bcanvas) return;
        any = true;
        drawBorder(windows.get(id), rec, ts);
      });
      if (!any) { cancelAnimationFrame(bRaf); bRaf = null; }
    };
    bRaf = requestAnimationFrame(tick);
  }

  function drawBorder(win, rec, ts) {
    if (!win) return;
    const o = win.opts || {};
    const cell = Math.max(2, Number(o.border_cell) || 4);
    const cols = Math.max(3, Math.ceil(win.w / cell)), rows = Math.max(3, Math.ceil(win.h / cell));
    const cv = rec.bcanvas;
    if (cv.width !== cols || cv.height !== rows) { cv.width = cols; cv.height = rows; }
    cv.style.width = win.w + 'px';
    cv.style.height = win.h + 'px';
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cols, rows);
    const a = hexRgb(o.border_color || '#ffffff'), b = hexRgb(o.border_color2 || '#7ef7c6');
    const n = 2 * (cols + rows) - 4, steps = 6, shift = (ts / 1000) * (Number(o.border_speed) || 0.15);
    let i = 0;
    const put = (x, y) => {
      let t = ((i / n) + shift) % 1;
      t = t < 0.5 ? t * 2 : (1 - t) * 2;
      t = Math.round(t * steps) / steps;
      ctx.fillStyle = `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
      ctx.fillRect(x, y, 1, 1);
      i++;
    };
    for (let x = 0; x < cols; x++) put(x, 0);
    for (let y = 1; y < rows; y++) put(cols - 1, y);
    for (let x = cols - 2; x >= 0; x--) put(x, rows - 1);
    for (let y = rows - 2; y >= 1; y--) put(0, y);
  }

  function applyBorder(win, rec) {
    const o = win.opts || {};
    const col = o.border_color || '';
    const pixel = o.border_mode === 'pixel' && col;
    rec.root.style.borderColor = pixel ? 'transparent' : col;
    rec.header.style.background = col;
    if (col) {
      const [r, g, b] = hexRgb(col);
      rec.header.style.color = (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#0a0d0a' : '#ffffff';
    } else rec.header.style.color = '';
    if (pixel) {
      if (!rec.bcanvas) {
        const cv = document.createElement('canvas');
        cv.style.cssText = 'position:absolute;left:-1px;top:-1px;pointer-events:none;image-rendering:pixelated;z-index:5';
        rec.root.appendChild(cv);
        rec.bcanvas = cv;
      }
      startBorderLoop();
    } else if (rec.bcanvas) {
      rec.bcanvas.remove();
      rec.bcanvas = null;
    }
  }

  function applyGeometry(win, rec) {'''),
    ("    rec.root.style.display = shouldHideWindowInOverlay ? 'none' : '';\n  }",
     "    rec.root.style.display = shouldHideWindowInOverlay ? 'none' : '';\n    applyBorder(win, rec);\n  }"),
])

# ───────────────────────── panels.js ─────────────────────────
def pixelate_init(s):
    a = s.index('const modeData = h.modeData;')
    b = s.index('    function frame() {')
    seg = s[a:b].replace('h.canvas.width', '(h.canvas.width * _pix(h))').replace('h.canvas.height', '(h.canvas.height * _pix(h))')
    return s[:a] + seg + s[b:]


ed('overlay/panels.js', [
    ('  return {\n    now_playing, lyrics,', r'''  const notepadCache = new Map();
  let latestCache = { follower: '', sub: '' };
  function cacheMsg(key, msg) {
    if (key === 'notepad' && msg) notepadCache.set(msg.id, msg.value || '');
    else if (key === 'latest') latestCache = msg || { follower: '', sub: '' };
  }

  function mdInline(s) {
    return s.replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  }
  function mdLine(raw) {
    const e = escapeHtml(raw);
    let m;
    if ((m = e.match(/^(#{1,3})\s+(.*)$/))) return `<div style="font-weight:700;font-size:${1.5 - 0.15 * m[1].length}em">${mdInline(m[2])}</div>`;
    if ((m = e.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) return `<div>${m[1] === ' ' ? '☐' : '☑'} ${mdInline(m[2])}</div>`;
    if ((m = e.match(/^\s*[-*]\s+(.*)$/))) return `<div>• ${mdInline(m[1])}</div>`;
    if ((m = e.match(/^&gt;\s?(.*)$/))) return `<div style="opacity:.7;border-left:2px solid currentColor;padding-left:6px">${mdInline(m[1])}</div>`;
    return `<div>${mdInline(e) || '&nbsp;'}</div>`;
  }
  function notepadRender(h, text) {
    const md = !h.win.opts || h.win.opts.notepad_markdown !== false;
    if (md) {
      h.box.style.whiteSpace = 'normal';
      h.box.innerHTML = String(text).split('\n').map(mdLine).join('');
    } else {
      h.box.style.whiteSpace = 'pre-wrap';
      h.box.textContent = text;
    }
  }
  const notepad = {
    mount(body, win) {
      body.classList.add('wm-term');
      body.style.whiteSpace = 'normal';
      body.style.overflow = 'auto';
      applyTextOpts(body, win && win.opts);
      const box = $create('div');
      body.appendChild(box);
      const h = { body, box, win };
      notepadRender(h, notepadCache.get(win.id) || '');
      return h;
    },
    onState(h, key, msg, o, wm, winId) {
      if (key !== 'notepad' || !msg || msg.id !== winId) return;
      notepadRender(h, msg.value || '');
    },
    applyOpts(h, win) {
      h.win = win;
      applyTextOpts(h.body, win.opts);
      notepadRender(h, notepadCache.get(win.id) || '');
    },
  };

  function latestRender(h) {
    const mode = (h.win && h.win.opts && h.win.opts.latest_show) || 'both';
    const rows = [];
    if (mode !== 'sub') rows.push(['follower', latestCache.follower]);
    if (mode !== 'follower') rows.push(['sub', latestCache.sub]);
    h.body.innerHTML = rows.map(([k, v]) => `<span class="line">${k.padEnd(9)}${escapeHtml(v || '—')}</span>`).join('');
  }
  const latest = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const h = { body, win };
      latestRender(h);
      return h;
    },
    onState(h, key) { if (key === 'latest') latestRender(h); },
    applyOpts(h, win) { h.win = win; applyTextOpts(h.body, win.opts); latestRender(h); },
  };

  return {
    now_playing, lyrics,'''),
    ('    escapeHtml,\n  };\n})();', '    notepad, latest, cacheMsg, escapeHtml,\n  };\n})();'),
    ('  function _spacerColor(h) {', "  function _pix(h) {\n    const p = Number(h.win && h.win.opts && h.win.opts.spacer_pixel);\n    return p >= 1 ? Math.min(12, Math.floor(p)) : 2;\n  }\n\n  function _spacerColor(h) {"),
    ('    applyOpts(h, win) {\n      h.win = win;\n      const kind = (win.opts && win.opts.spacer_kind) || \'bootlog\';',
     '    applyOpts(h, win) {\n      h.win = win;\n      if (h.resize) h.resize();\n      const kind = (win.opts && win.opts.spacer_kind) || \'bootlog\';'),
    ("    h.canvas.style.display = 'block';", "    h.canvas.style.display = 'block';\n    h.canvas.style.imageRendering = 'pixelated';"),
    ('''    function resize() {
      const rect = h.canvas.parentElement ? h.canvas.parentElement.getBoundingClientRect() : { width: 300, height: 200 };
      h.canvas.width = rect.width || 300;
      h.canvas.height = rect.height || 200;
    }
    resize();

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    h.cleanups.push(() => window.removeEventListener('resize', onResize));''',
     '''    function resize() {
      const P = _pix(h);
      h.canvas.width = Math.max(1, Math.floor((h.body.clientWidth || 300) / P));
      h.canvas.height = Math.max(1, Math.floor((h.body.clientHeight || 200) / P));
    }
    h.resize = resize;
    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(h.body);
    h.cleanups.push(() => ro.disconnect());'''),
    pixelate_init,
    ('''    function frame() {
      h.t += 1;
      const w = h.canvas.width;
      const hg = h.canvas.height;''',
     '''    function frame() {
      h.t += 1;
      const P = _pix(h);
      ctx.setTransform(1 / P, 0, 0, 1 / P, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const w = h.canvas.width * P;
      const hg = h.canvas.height * P;'''),
    ('const img = ctx.createImageData(w, hg);', 'const img = ctx.createImageData(h.canvas.width, h.canvas.height);'),
])

# ───────────────────────── overlay.html ─────────────────────────
ed('overlay/overlay.html', [
    ("  let ws = null;\n  const overlayState",
     "  let ws = null;\n  const layoutName = (new URLSearchParams(location.search)).get('layout') || 'main';\n  const overlayState"),
    ('function broadcastToAllPanels(key, msg) {\n    wm.forEachWindow((win) => {',
     'function broadcastToAllPanels(key, msg) {\n    Panels.cacheMsg(key, msg);\n    wm.forEachWindow((win) => {'),
    ('applyLayoutFromServer(s.wm_layout);',
     "applyLayoutFromServer((s.wm_layouts && s.wm_layouts[layoutName]) || (layoutName === 'main' ? s.wm_layout : null));"),
    ("if (s.ads) broadcastToAllPanels('ads_state', s.ads);",
     "if (s.ads) broadcastToAllPanels('ads_state', s.ads);\n      if (s.latest) broadcastToAllPanels('latest', s.latest);\n      Object.entries(s.notepads || {}).forEach(([id, value]) => broadcastToAllPanels('notepad', { id, value }));"),
    ("if (t === 'wm_layout') { applyLayoutFromServer(msg.layout); return; }",
     "if (t === 'wm_layout') { if ((msg.name || 'main') === layoutName) applyLayoutFromServer(msg.layout); return; }"),
    ("    if (t === 'canvas_pixel') { broadcastToAllPanels('canvas_pixel', msg); return; }",
     "    if (t === 'canvas_pixel') { broadcastToAllPanels('canvas_pixel', msg); return; }\n    if (t === 'notepad') { broadcastToAllPanels('notepad', msg); return; }\n    if (t === 'latest') { broadcastToAllPanels('latest', msg.latest); return; }"),
])

# ───────────────────────── control.html ─────────────────────────
ed('overlay/control.html', [
    ('<div class="side-title">grid snap</div>', r'''<div class="side-title">overlay</div>
    <select id="overlay-select"></select>
    <div class="field-row"><button id="btn-overlay-new" type="button">new</button><button id="btn-overlay-del" type="button" style="color:var(--red)">delete</button></div>
    <div class="hint" id="overlay-url" style="word-break:break-all;"></div>

    <div class="side-title">grid snap</div>'''),
    ('<div class="side-title">add window</div>', r'''<div class="side-title">bulk colors</div>
    <div class="field-row"><input type="color" id="bulk-border" value="#ffffff"><input type="color" id="bulk-border2" value="#7ef7c6"></div>
    <select id="bulk-border-mode" style="margin-top:6px;"><option value="solid">solid borders</option><option value="pixel">pixel gradient borders</option><option value="default">default (remove)</option></select>
    <button id="bulk-border-apply" type="button">apply to all borders</button>
    <div class="field-row"><input type="color" id="bulk-spacer" value="#4ade80"></div>
    <button id="bulk-spacer-apply" type="button">apply to all spacers</button>
    <div class="field-row"><input type="color" id="bulk-text" value="#d8dee2"></div>
    <button id="bulk-text-apply" type="button">apply to all text</button>

    <div class="side-title">add window</div>'''),
    ('<option value="canvas">canvas (popup)</option>',
     '<option value="canvas">canvas (popup)</option>\n      <option value="notepad">notepad</option>\n      <option value="latest">latest follower / sub</option>'),
    ('<button id="btn-apply-edit">apply</button>', r'''<div class="field">
        <label>border</label>
        <select id="ed-border-mode"><option value="default">default</option><option value="solid">solid</option><option value="pixel">pixel gradient</option></select>
        <div class="field-row"><input type="color" id="ed-border-color" value="#ffffff"><input type="color" id="ed-border-color2" value="#7ef7c6"></div>
      </div>
      <div class="field" id="ed-spacer-pixel-row" style="display:none;">
        <label>spacer pixel size</label>
        <input type="number" id="ed-spacer-pixel" min="1" max="12" value="2">
      </div>
      <div class="field" id="ed-notepad-row" style="display:none;">
        <label>notepad text (live)</label>
        <textarea id="ed-notepad-text" rows="8" style="width:100%;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px;border:1px solid var(--line-lit);resize:vertical;"></textarea>
        <div class="row" style="margin-top:4px;"><label style="margin:0;"><input type="checkbox" id="ed-notepad-md" checked style="width:auto;"> markdown (apply to toggle)</label></div>
      </div>
      <div class="field" id="ed-latest-row" style="display:none;">
        <label>show</label>
        <select id="ed-latest-show"><option value="both">follower + sub</option><option value="follower">follower only</option><option value="sub">sub only</option></select>
      </div>
      <button id="btn-apply-edit">apply</button>'''),
    ('let selectedWinId = null;', "let selectedWinId = null;\nlet currentOverlay = 'main';"),
    ("  const existing = new Set(wm.getLayout().map(w => w.id));",
     "  const existing = new Set(wm.getLayout().map(w => w.id));\n  Object.values(state.wm_layouts || {}).forEach(l => (l || []).forEach(w => existing.add(w.id)));"),
    ("  onLayoutChange: (layout) => {\n    send({ cmd: 'wm_layout_set', layout });\n    refreshWinList();\n  },",
     "  onLayoutChange: (layout) => {\n    state.wm_layouts = state.wm_layouts || {};\n    state.wm_layouts[currentOverlay] = layout;\n    send({ cmd: 'wm_layout_set', name: currentOverlay, layout });\n    refreshWinList();\n  },"),
    ("send({ cmd: 'wm_layout_set', layout: wm.getLayout() });",
     "send({ cmd: 'wm_layout_set', name: currentOverlay, layout: wm.getLayout() });", 2),
    ("$('ed-canvas-size-row').style.display = win.panel === 'canvas' ? '' : 'none';\n}", r'''$('ed-canvas-size-row').style.display = win.panel === 'canvas' ? '' : 'none';
  const wo = win.opts || {};
  $('ed-border-mode').value = wo.border_mode || 'default';
  $('ed-border-color').value = wo.border_color || '#ffffff';
  $('ed-border-color2').value = wo.border_color2 || '#7ef7c6';
  $('ed-spacer-pixel-row').style.display = isSpacer ? '' : 'none';
  $('ed-spacer-pixel').value = wo.spacer_pixel || 2;
  $('ed-notepad-row').style.display = win.panel === 'notepad' ? '' : 'none';
  if (win.panel === 'notepad') {
    $('ed-notepad-md').checked = wo.notepad_markdown !== false;
    $('ed-notepad-text').value = (state.notepads || {})[win.id] || '';
  }
  $('ed-latest-row').style.display = win.panel === 'latest' ? '' : 'none';
  if (win.panel === 'latest') $('ed-latest-show').value = wo.latest_show || 'both';
}'''),
    ('  patch.opts = opts;', r'''  const bm = $('ed-border-mode').value;
  if (bm === 'default') { delete opts.border_mode; delete opts.border_color; delete opts.border_color2; }
  else { opts.border_mode = bm; opts.border_color = $('ed-border-color').value; opts.border_color2 = $('ed-border-color2').value; }
  if (win.panel === 'spacer') opts.spacer_pixel = parseInt($('ed-spacer-pixel').value, 10) || 2;
  if (win.panel === 'notepad') opts.notepad_markdown = $('ed-notepad-md').checked;
  if (win.panel === 'latest') opts.latest_show = $('ed-latest-show').value;
  patch.opts = opts;'''),
    ("ad_warning: 'ad break', canvas: 'canvas',\n};", "ad_warning: 'ad break', canvas: 'canvas', notepad: 'notes', latest: 'latest',\n};"),
    ('''    case 'init':
      state = msg.state;
      renderAll();
      if (Array.isArray(state.wm_layout) && state.wm_layout.length) {
        wm.setLayout(state.wm_layout, { silent: true });
      } else {
        wm.setLayout(DEFAULT_LAYOUT, { silent: true });
      }
      refreshWinList();
      fitStage();
      break;
    case 'wm_layout':
      wm.setLayout(msg.layout, { silent: true });
      refreshWinList();
      break;''', r'''    case 'init':
      state = msg.state;
      state.wm_layouts = state.wm_layouts || {};
      if (!state.wm_layouts.main) state.wm_layouts.main = state.wm_layout || [];
      if (!state.wm_layouts[currentOverlay]) currentOverlay = 'main';
      loadOverlay(currentOverlay);
      renderOverlaySelect();
      renderAll();
      fitStage();
      break;
    case 'wm_layout': {
      const nm = msg.name || 'main';
      state.wm_layouts = state.wm_layouts || {};
      state.wm_layouts[nm] = msg.layout;
      if (nm === currentOverlay) { wm.setLayout(msg.layout, { silent: true }); refreshWinList(); }
      renderOverlaySelect();
      break;
    }
    case 'wm_layout_deleted':
      delete (state.wm_layouts || {})[msg.name];
      if (currentOverlay === msg.name) loadOverlay('main');
      renderOverlaySelect();
      break;
    case 'notepad':
      state.notepads = state.notepads || {};
      state.notepads[msg.id] = msg.value;
      broadcastToAllPanels('notepad', msg);
      break;
    case 'latest':
      state.latest = msg.latest;
      broadcastToAllPanels('latest', msg.latest);
      break;'''),
    ('function broadcastToAllPanels(key, msg) {\n  wm.forEachWindow(win => {',
     'function broadcastToAllPanels(key, msg) {\n  Panels.cacheMsg(key, msg);\n  wm.forEachWindow(win => {'),
    ("  if (state.message !== undefined) broadcastToAllPanels('message', { value: state.message });\n}",
     "  if (state.message !== undefined) broadcastToAllPanels('message', { value: state.message });\n  Object.entries(state.notepads || {}).forEach(([id, value]) => broadcastToAllPanels('notepad', { id, value }));\n  if (state.latest) broadcastToAllPanels('latest', state.latest);\n}"),
    ('renderPresets();\nrefreshLayoutConfigList();\nconnect();', r'''function loadOverlay(name) {
  currentOverlay = name;
  const l = (state.wm_layouts || {})[name];
  selectedWinId = null;
  refreshWinEditor();
  wm.setLayout(l && l.length ? l : DEFAULT_LAYOUT, { silent: true });
  refreshWinList();
  $('overlay-url').textContent = `obs url: http://${location.host}/overlay?layout=${name}`;
}
function renderOverlaySelect() {
  const names = Object.keys(state.wm_layouts || {});
  if (!names.includes('main')) names.unshift('main');
  $('overlay-select').innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
  $('overlay-select').value = currentOverlay;
}
$('overlay-select').onchange = () => loadOverlay($('overlay-select').value);
$('btn-overlay-new').onclick = () => {
  const n = (prompt('overlay name (e.g. brb):') || '').trim().replace(/[^\w\-]/g, '_').slice(0, 40);
  if (!n || (state.wm_layouts || {})[n]) return;
  state.wm_layouts[n] = wm.getLayout();
  send({ cmd: 'wm_layout_set', name: n, layout: state.wm_layouts[n] });
  loadOverlay(n);
  renderOverlaySelect();
};
$('btn-overlay-del').onclick = () => {
  if (currentOverlay === 'main') { toast("can't delete main"); return; }
  if (!confirm('delete overlay "' + currentOverlay + '"?')) return;
  const n = currentOverlay;
  delete state.wm_layouts[n];
  send({ cmd: 'wm_layout_delete', name: n });
  loadOverlay('main');
  renderOverlaySelect();
};

function bulkOpts(fn) {
  wm.getLayout().forEach(w => {
    const o = { ...(w.opts || {}) };
    if (fn(w, o) !== false) wm.updateWindow(w.id, { opts: o }, { silent: true });
  });
  const layout = wm.getLayout();
  state.wm_layouts[currentOverlay] = layout;
  send({ cmd: 'wm_layout_set', name: currentOverlay, layout });
  refreshWinEditor();
  toast('applied');
}
$('bulk-border-apply').onclick = () => bulkOpts((w, o) => {
  const m = $('bulk-border-mode').value;
  if (m === 'default') { delete o.border_mode; delete o.border_color; delete o.border_color2; return; }
  o.border_mode = m; o.border_color = $('bulk-border').value; o.border_color2 = $('bulk-border2').value;
});
$('bulk-spacer-apply').onclick = () => bulkOpts((w, o) => { if (w.panel !== 'spacer') return false; o.spacer_color = $('bulk-spacer').value; });
$('bulk-text-apply').onclick = () => bulkOpts((w, o) => { o.text_color = $('bulk-text').value; });

let npTimer = null;
$('ed-notepad-text').addEventListener('input', () => {
  if (!selectedWinId) return;
  const id = selectedWinId, value = $('ed-notepad-text').value;
  state.notepads = state.notepads || {};
  state.notepads[id] = value;
  broadcastToAllPanels('notepad', { id, value });
  clearTimeout(npTimer);
  npTimer = setTimeout(() => send({ cmd: 'notepad_set', id, value }), 150);
});

renderPresets();
refreshLayoutConfigList();
connect();'''),
])

for rel, (text, crlf) in OUT.items():
    p = R / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes((text.replace('\n', '\r\n') if crlf else text).encode('utf-8'))
    print('wrote', rel)
