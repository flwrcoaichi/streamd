/*
 * panels.js — per-window-type content renderers for the streamd overlay.
 * Shared by overlay.html (render-only) and control.html (editable mirror).
 *
 * Each panel exposes:
 *   mount(bodyEl, win)   — called once when the window is created; build DOM, return a handle
 *   onState(handle, key, payload, overlayState, wm, winId) — called on relevant websocket messages
 *   applyOpts(handle, win) — OPTIONAL. called when win.opts changes (e.g. font size/color edited
 *                            in control.html) WITHOUT remounting the panel. Panels that support
 *                            live style edits (chat, extra, tts_transcript, socials, message_bar,
 *                            ad_warning) implement this so font-size changes actually take effect
 *                            without losing panel state.
 *   unmount(handle)      — called when the window is removed (cleanup timers/RAF)
 */

const Panels = (() => {

  const $create = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function applyTextOpts(bodyEl, opts) {
    opts = opts || {};
    bodyEl.style.color = opts.text_color || '';
    bodyEl.style.backgroundColor = opts.bg_color || '';
    bodyEl.style.fontSize = (opts.font_size || 13) + 'px';
    bodyEl.style.fontFamily = opts.font_family === 'sans-serif' ? 'sans-serif' : 'monospace';
  }

  function normalizeKeyPanelConfig(config) {
    const base = {
      shape: 'round',
      size: 48,
      gap: 8,
      active_color: '#7ef7c6',
      inactive_color: '#1f2731',
      text_color: '#f5f7fa',
      keys: [],
      active_keys: [],
    };
    const data = { ...base, ...(config || {}) };
    data.keys = Array.isArray(data.keys) ? data.keys : [];
    data.active_keys = Array.isArray(data.active_keys) ? data.active_keys : [];
    return data;
  }

  function normalizeKeyLabel(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    const normalized = value.toLowerCase().replace(/^key\./, '').replace(/\s+/g, '');
    if (normalized === ' ' || normalized === 'space') return 'space';
    const aliases = { 'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right', 'leftctrl': 'ctrl', 'rightctrl': 'ctrl', 'leftalt': 'alt', 'rightalt': 'alt', 'leftshift': 'shift', 'rightshift': 'shift', 'enterkey': 'enter' };
    return aliases[normalized] || normalized;
  }

  function keyPanelDisplayLabel(item, keyName) {
    const explicit = item && (item.label || item.text || item.title);
    if (explicit && String(explicit).trim()) return String(explicit).trim();
    const glyphs = { up: '↑', down: '↓', left: '←', right: '→', space: 'SPACE' };
    if (glyphs[keyName]) return glyphs[keyName];
    return (keyName || '').toUpperCase();
  }

  // ── 7TV emotes (shared across chat panel instances) ─────────────────────
  const sevenTv = new Map();
  let sevenTvLoaded = false;
  async function ensure7tv(channelLogin) {
    if (sevenTvLoaded) return;
    sevenTvLoaded = true;
    try {
      const res = await fetch('https://7tv.io/v3/emote-sets/global');
      if (res.ok) {
        const data = await res.json();
        for (const e of (data.emotes || [])) {
          const host = e.data && e.data.host;
          if (!host) continue;
          const file = (host.files || []).find(f => f.format === 'WEBP' && f.name === '1x.webp') || (host.files || [])[0];
          if (file) sevenTv.set(e.name, `https:${host.url}/${file.name}`);
        }
      }
    } catch (e) { /* non-fatal */ }
    if (!channelLogin) return;
    try {
      const idRes = await fetch(`https://decapi.me/twitch/id/${encodeURIComponent(channelLogin)}`);
      if (!idRes.ok) return;
      const text = (await idRes.text()).trim();
      if (!/^\d+$/.test(text)) return;
      const userRes = await fetch(`https://7tv.io/v3/users/twitch/${text}`);
      if (!userRes.ok) return;
      const userData = await userRes.json();
      const emotes = (userData.emote_set && userData.emote_set.emotes) || [];
      for (const e of emotes) {
        const host = e.data && e.data.host;
        if (!host) continue;
        const file = (host.files || []).find(f => f.format === 'WEBP' && f.name === '1x.webp') || (host.files || [])[0];
        if (file) sevenTv.set(e.name, `https:${host.url}/${file.name}`);
      }
    } catch (e) { /* non-fatal */ }
  }

  function renderChatText(text, emotes) {
    let segments = [];
    const sorted = emotes ? [...emotes].sort((a, b) => a.start - b.start) : [];
    let cursor = 0;
    for (const e of sorted) {
      if (e.start < cursor) continue;
      if (e.start > cursor) segments.push({ text: text.slice(cursor, e.start), isEmote: false });
      segments.push({ text: e.name, isEmote: true, url: e.url, name: e.name });
      cursor = e.end + 1;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), isEmote: false });
    let out = '';
    for (const seg of segments) {
      if (seg.isEmote) {
        out += `<img class="wm-emote" src="${seg.url}" alt="${escapeHtml(seg.name)}" title="${escapeHtml(seg.name)}" />`;
        continue;
      }
      const words = seg.text.split(/(\s+)/);
      for (const word of words) {
        const url = sevenTv.get(word);
        if (url) out += `<img class="wm-emote" src="${url}" alt="${escapeHtml(word)}" title="${escapeHtml(word)} [7tv]" />`;
        else out += escapeHtml(word);
      }
    }
    return out;
  }

  // ── now_playing ───────────────────────────────────────────────────────
  const now_playing = {
    mount(body, win) {
      body.innerHTML = `
        <div class="np-bg"><div class="np-art"></div><video class="np-video" autoplay loop muted playsinline></video><div class="np-grad"></div></div>
        <div class="np-fg">
          <span class="np-status">▶</span>
          <span class="np-track">—</span>
          <span class="np-artist"></span>
        </div>`;
      return {
        art: body.querySelector('.np-art'),
        video: body.querySelector('.np-video'),
        track: body.querySelector('.np-track'),
        artist: body.querySelector('.np-artist'),
        status: body.querySelector('.np-status'),
        lastKey: '',
      };
    },
    onState(h, key, msg) {
      if (key === 'music') {
        const m = msg;
        h.track.textContent = m.title || '—';
        h.artist.textContent = m.artist ? `— ${m.artist}` : '';
        h.status.textContent = m.playing ? '▶' : '⏸';
        const k = `${m.title}::${m.artist}`;
        if (k !== h.lastKey) {
          h.lastKey = k;
          if (m.title && m.title !== '—') {
            h.art.style.backgroundImage = `url('/art.png?t=${Date.now()}')`;
          } else {
            h.art.style.backgroundImage = '';
          }
        }
      } else if (key === 'music_video') {
        if (msg.url) {
          h.video.src = msg.url;
          h.video.classList.add('active');
        } else {
          h.video.classList.remove('active');
          h.video.removeAttribute('src');
        }
      }
    },
  };

  // ── lyrics ───────────────────────────────────────────────────────────
  const lyrics = {
    mount(body, win) {
      body.classList.add('wm-term');
      const box = $create('div', 'lyrics-box');
      body.appendChild(box);
      return { box, data: { synced_lines: [], synced_words: [], plain_lines: [] }, raf: null, musicState: { playing: false, duration: 0, position: 0, _updatedAt: 0 } };
    },
    onState(h, key, msg) {
      if (key === 'music') {
        h.musicState = { playing: msg.playing, duration: Number(msg.duration) || 0, position: Number(msg.position) || 0, _updatedAt: performance.now() };
      } else if (key === 'lyrics') {
        if (!msg.found) {
          h.data = { synced_lines: [], synced_words: [], plain_lines: [] };
          h.box.innerHTML = '<span class="wm-dim">no lyrics</span>';
          return;
        }
        h.data = {
          synced_lines: msg.synced_lines || [],
          synced_words: msg.synced_words || [],
          plain_lines: msg.plain_lines || msg.lines || [],
        };
        startLoop(h);
      }
    },
    unmount(h) { if (h.raf) cancelAnimationFrame(h.raf); },
  };
  function elapsedSeconds(h) {
    if (!h.musicState.playing) return h.musicState.position;
    return h.musicState.position + (performance.now() - h.musicState._updatedAt) / 1000;
  }
  function activeLineIndex(h, elapsed) {
    const lines = h.data.synced_lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].time <= elapsed) idx = i; else break; }
    return idx;
  }
  function renderLyricsDOM(h) {
    const elapsed = elapsedSeconds(h);
    const lines = h.data.synced_lines, words = h.data.synced_words, plain = h.data.plain_lines;
    let displayLines = [], activeIdx = -1;
    const ABOVE = 2, BELOW = 3;
    if (lines.length) {
      activeIdx = activeLineIndex(h, elapsed);
      const start = Math.max(0, activeIdx - ABOVE);
      const end = Math.min(lines.length - 1, (activeIdx < 0 ? BELOW - 1 : activeIdx) + BELOW);
      for (let i = start; i <= end; i++) displayLines.push({ idx: i, text: lines[i].text, time: lines[i].time });
    } else if (plain.length) {
      const dur = h.musicState.duration || 180;
      const prog = Math.min(1, Math.max(0, elapsed / dur));
      const mid = Math.floor(prog * plain.length);
      const start = Math.max(0, mid - ABOVE), end = Math.min(plain.length - 1, mid + BELOW);
      for (let i = start; i <= end; i++) displayLines.push({ idx: i, text: plain[i], time: null });
      activeIdx = mid;
    }
    if (!displayLines.length) { h.box.innerHTML = '<span class="wm-dim">—</span>'; return; }
    h.box.innerHTML = '';
    for (const dl of displayLines) {
      const lineEl = $create('div', 'lyric-line' + (dl.idx === activeIdx ? ' active' : (dl.idx === activeIdx + 1 ? ' next' : '')));
      if (dl.idx === activeIdx && words.length && dl.text) {
        const lineStart = dl.time, nextLine = lines[dl.idx + 1], lineEnd = nextLine ? nextLine.time : Infinity;
        const lineWords = words.filter(w => w.time >= lineStart && w.time < lineEnd);
        if (lineWords.length) {
          for (const w of lineWords) {
            const span = $create('span', 'lyric-word' + (elapsed >= w.time ? ' sung' : ''));
            span.textContent = w.word + ' ';
            lineEl.appendChild(span);
          }
        } else lineEl.textContent = dl.text;
      } else lineEl.textContent = dl.text || ' ';
      h.box.appendChild(lineEl);
    }
  }
  function startLoop(h) {
    if (h.raf) cancelAnimationFrame(h.raf);
    const tick = () => { renderLyricsDOM(h); h.raf = requestAnimationFrame(tick); };
    tick();
  }

  // ── status (pc stats) ────────────────────────────────────────────────
  const status = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      body.innerHTML =
        `<span class="line">cpu    <span data-k="cpu">…</span></span>` +
        `<span class="line">mem    <span data-k="mem">…</span></span>` +
        `<span class="line">gpu    <span data-k="gpu">…</span></span>` +
        `<span class="line">wpm    <span data-k="wpm">…</span></span>` +
        `<span class="line">uptime <span data-k="uptime">…</span></span>`;
      const els = {};
      body.querySelectorAll('[data-k]').forEach(e => els[e.dataset.k] = e);
      return { body, els };
    },
    onState(h, key, msg) {
      if (key !== 'stats') return;
      for (const k of ['cpu', 'mem', 'gpu', 'wpm', 'uptime']) {
        if (msg[k] !== undefined && h.els[k]) h.els[k].textContent = msg[k];
      }
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── socials ──────────────────────────────────────────────────────────
  const socials = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const lines = ((win && win.opts && win.opts.social_lines) || 'twitter: @vanillyn_net\ndiscord: @vanillyn').split(/\r?\n/).filter(Boolean);
      body.innerHTML = lines.map(l => `<span class="line">${escapeHtml(l)}</span>`).join('') + '<span class="wm-cursor">&nbsp;</span>';
      return { body };
    },
    onState() {},
    applyOpts(h, win) {
      applyTextOpts(h.body, win.opts);
      const lines = ((win.opts && win.opts.social_lines) || '').split(/\r?\n/).filter(Boolean);
      h.body.innerHTML = lines.map(l => `<span class="line">${escapeHtml(l)}</span>`).join('') + '<span class="wm-cursor">&nbsp;</span>';
    },
  };

  // ── message bar ─────────────────────────────────────────────────────
  const message_bar = {
    mount(body, win) {
      body.classList.add('wm-term');
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'center';
      body.style.overflow = 'auto';
      body.style.whiteSpace = 'normal';
      body.style.wordBreak = 'break-word';
      applyTextOpts(body, win && win.opts);
      const line = $create('div', 'message-bar-line');
      line.style.fontWeight = '700';
      line.style.whiteSpace = 'normal';
      line.style.wordBreak = 'break-word';
      line.style.textOverflow = 'clip';
      line.style.overflow = 'visible';
      line.style.width = '100%';
      body.appendChild(line);
      return { body, line };
    },
    onState(h, key, msg) {
      if (key !== 'message') return;
      h.line.textContent = msg && msg.value ? String(msg.value) : '';
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── screen (deliberately blank — OBS source layered manually) ──────────
  const screen = {
    mount(body) { body.style.background = 'transparent'; return {}; },
    onState() {},
  };

  // ── key panel ────────────────────────────────────────────────────────
  const key_panel = {
    mount(body, win) {
      body.classList.add('key-panel-body');
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'center';
      body.style.padding = '10px';
      body.style.boxSizing = 'border-box';
      const wrap = $create('div', 'key-panel-row');
      body.appendChild(wrap);
      return { body, wrap };
    },
    onState(h, key, msg) {
      if (key !== 'key_panel') return;
      const cfg = normalizeKeyPanelConfig(msg);
      renderKeyPanel(h, cfg);
    },
    applyOpts(h, win) {
      renderKeyPanel(h, normalizeKeyPanelConfig(win && win.opts));
    },
  };

  function renderKeyPanel(h, cfg) {
    const panel = normalizeKeyPanelConfig(cfg);
    h.wrap.innerHTML = '';
    const activeMap = new Set((panel.active_keys || []).map(key => normalizeKeyLabel(key)));
    const itemShape = panel.shape || 'round';
    const keyItems = panel.keys || [];
    const positioned = keyItems.some(item => Number.isFinite(Number(item.x)) || Number.isFinite(Number(item.y)));
    const glowEnabled = panel.glow !== false;
    const useBorder = panel.border !== false && (!itemShape || itemShape !== 'none');
    h.wrap.style.position = positioned ? 'relative' : '';
    h.wrap.style.display = positioned ? 'block' : 'flex';
    h.wrap.style.alignItems = positioned ? '' : 'center';
    h.wrap.style.justifyContent = positioned ? '' : 'center';
    h.wrap.style.width = '100%';
    h.wrap.style.height = '100%';
    for (const [index, item] of keyItems.entries()) {
      const keyName = normalizeKeyLabel(item.key || item.label || '');
      if (!keyName) continue;
      const square = $create('div', `key-panel-key key-panel-${item.shape || itemShape}`);
      const label = $create('span');
      label.textContent = keyPanelDisplayLabel(item, keyName);
      square.appendChild(label);
      const active = activeMap.has(keyName) || !!item.active;
      const keyColor = item.color || panel.active_color || '#7ef7c6';
      const inactiveColor = item.bg_color || panel.inactive_color || '#1f2731';
      const textColor = panel.text_color || '#f5f7fa';
      const keySize = panel.size || 48;
      const gap = Math.max(2, panel.gap || 8);
      const borderWidth = Number.isFinite(Number(item.border_width ?? panel.border_width)) ? Number(item.border_width ?? panel.border_width) : (panel.border_width || 1);
      const borderColor = item.border_color || panel.border_color || 'rgba(255,255,255,0.18)';
      const radiusValue = item.corner_radius ?? panel.corner_radius ?? (
        (item.shape || itemShape || 'round') === 'square' ? '0px' :
        (item.shape || itemShape || 'round') === 'diamond' ? '8px' :
        ((item.shape || itemShape || 'round') === 'pill' || (item.shape || itemShape || 'round') === 'round') ? '999px' : '0px'
      );
      square.style.setProperty('--key-color', keyColor);
      square.style.setProperty('--key-bg', inactiveColor);
      square.style.setProperty('--key-text', textColor);
      square.style.width = `${keySize}px`;
      square.style.height = `${keySize}px`;
      square.style.border = (panel.border === false || item.border === false) ? 'none' : `${Math.max(0, borderWidth)}px solid ${borderColor}`;
      square.style.borderColor = active ? keyColor : borderColor;
      square.style.background = active ? keyColor : inactiveColor;
      square.style.color = active ? '#08120d' : textColor;
      square.style.borderRadius = radiusValue;
      square.style.boxShadow = glowEnabled && active ? '0 0 12px color-mix(in srgb, var(--key-color, #7ef7c6) 60%, transparent), inset 0 0 0 1px rgba(0,0,0,0.2)' : 'none';
      if (positioned) {
        const x = Number.isFinite(Number(item.x)) ? Number(item.x) : index * (keySize + gap);
        const y = Number.isFinite(Number(item.y)) ? Number(item.y) : 0;
        square.style.position = 'absolute';
        square.style.left = `${x}px`;
        square.style.top = `${y}px`;
        square.style.margin = '0';
      } else {
        square.style.margin = `0 ${gap / 2}px`;
        square.style.position = 'static';
      }
      if (active) square.classList.add('active');
      h.wrap.appendChild(square);
    }
  }

  // ── chat ─────────────────────────────────────────────────────────────
  const CHAT_MAX = 40;
  const chat = {
    mount(body, win, ctx) {
      body.classList.add('wm-chat-body');
      applyTextOpts(body, win && win.opts);
      ensure7tv(ctx && ctx.channel);
      return { body };
    },
    onState(h, key, msg) {
      if (key !== 'chat') return;
      const line = $create('div', 'chat-line');
      const badges = (msg.badges || []).map(b => `<img class="chat-badge" src="${b.url}" alt="" />`).join('');
      const nameStyle = msg.color ? ` style="color:${msg.color}"` : '';
      line.innerHTML = `<span class="chat-user"${nameStyle}>${badges}${escapeHtml(msg.user)}:</span> <span class="chat-text">${renderChatText(msg.text, msg.emotes)}</span>`;
      h.body.appendChild(line);
      while (h.body.children.length > CHAT_MAX) h.body.removeChild(h.body.firstChild);
      h.body.scrollTop = h.body.scrollHeight;
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── extra ────────────────────────────────────────────────────────────
  const extra = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const content = $create('div');
      content.innerHTML = '<span class="wm-dim">—</span>';
      body.appendChild(content);
      return { body, content };
    },
    onState(h, key, msg) {
      if (key !== 'extra') return;
      h.content.innerHTML = msg.value ||
        'flwr/ashOS pre-4<br>© 1998-2026 flowerCO, © ???? ????????<br>For Monitoring S0-ACZ4<br>' +
        '<span style="color: teal ;">Failed to monitor CAM1 on Channel4</span><br>Monitoring DWM1 on Channel4';
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── words on stream (wos.gg) ─────────────────────────────────────────
  // only shown/hidden via !words / !endwords (broadcaster-only chat
  // commands) or the control panel. per vanillyn: audio must fully
  // unload on !endwords, not just hide — so we swap the iframe's src
  // to blank instead of toggling visibility, forcing the browser to
  // tear down any media the page was playing.
  const words = {
    mount(body, win) {
      body.style.background = 'transparent';
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'center';
      body.style.color = 'rgba(255,255,255,0.1)';
      const blank = document.createElement('div');
      blank.style.width = '100%';
      blank.style.height = '100%';
      blank.style.background = 'rgba(0,0,0,0.02)';
      body.appendChild(blank);
      return { body, blank, active: false };
    },
    onState(h, key, msg, overlayState, wm, winId) {
      if (key !== 'words') return;
      const active = !!(msg && msg.active);
      h.active = active;
      if (wm && winId) wm.showPopup(winId, active);
      if (h.body) {
        h.body.style.opacity = active ? '1' : '0';
      }
    },
    applyOpts(h, win) {
      if (h.body) h.body.style.opacity = h.active ? '1' : '0';
    },
  };

  // ── tts transcript ───────────────────────────────────────────────────
  // shows what's queued/generating/being spoken via tts, so chat (and
  // vanillyn) aren't confused when audio starts with no visible context.
  // reuses the existing tts_state generating/speaking/current fields.
  const tts_transcript = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const label = $create('div', 'line wm-dim');
      label.textContent = 'tts: idle';
      const text = $create('div', 'line');
      text.style.whiteSpace = 'pre-wrap';
      body.appendChild(label);
      body.appendChild(text);
      return { body, label, text };
    },
    onState(h, key, msg) {
      if (key !== 'tts_state') return;
      const t = msg || {};
      if (t.generating) h.label.textContent = 'tts: generating…';
      else if (t.speaking) h.label.textContent = 'tts: speaking';
      else h.label.textContent = 'tts: idle';
      h.text.textContent = t.current || '';
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── ad warning ───────────────────────────────────────────────────────
  // only visible when an ad is imminent or currently running. reuses the
  // existing ads_state (in_ad_break / seconds_until).
  const ad_warning = {
    mount(body, win) {
      body.classList.add('wm-term', 'alerts-body');
      applyTextOpts(body, win && win.opts);
      const line = $create('div', 'line');
      line.style.fontWeight = '700';
      body.appendChild(line);
      return { body, line };
    },
    onState(h, key, msg, overlayState, wm, winId) {
      if (key !== 'ads_state') return;
      const ads = msg || {};
      if (ads.in_ad_break) {
        h.line.textContent = 'ad break in progress';
        if (wm && winId) wm.showPopup(winId, true);
      } else if (typeof ads.seconds_until === 'number' && ads.seconds_until > 0 && ads.seconds_until <= 120) {
        const secs = Math.max(0, Math.round(ads.seconds_until));
        h.line.textContent = `ad break in ~${secs}s`;
        if (wm && winId) wm.showPopup(winId, true);
      } else {
        if (wm && winId) wm.showPopup(winId, false);
      }
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

  // ── canvas (collaborative pixel art) ─────────────────────────────────
  // hidden by default (popup kind), shown periodically by the daemon or
  // on !canvas / control panel. renders from a sparse "x,y" -> "#hex" map
  // and patches individual cells as canvas_pixel events arrive.
  const canvas = {
    mount(body, win) {
      body.style.background = (win.opts && win.opts.bg_color) || '#0a0c0d';
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'center';
      const size = (win.opts && win.opts.size) || 100;
      const cvs = document.createElement('canvas');
      cvs.width = size;
      cvs.height = size;
      cvs.style.width = '100%';
      cvs.style.height = '100%';
      cvs.style.imageRendering = 'pixelated';
      body.appendChild(cvs);
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = '#1a1e22';
      ctx.fillRect(0, 0, size, size);
      return { body, cvs, ctx, size };
    },
    onState(h, key, msg, overlayState, wm, winId) {
      if (key === 'canvas_state') {
        const c = msg || {};
        if (c.size && c.size !== h.size) {
          h.size = c.size;
          h.cvs.width = c.size;
          h.cvs.height = c.size;
        }
        h.ctx.fillStyle = '#1a1e22';
        h.ctx.fillRect(0, 0, h.size, h.size);
        const pixels = c.pixels || {};
        for (const k in pixels) {
          const parts = k.split(',');
          const x = Number(parts[0]), y = Number(parts[1]);
          h.ctx.fillStyle = pixels[k];
          h.ctx.fillRect(x, y, 1, 1);
        }
        if (wm && winId) wm.showPopup(winId, !!c.visible);
      } else if (key === 'canvas_pixel') {
        h.ctx.fillStyle = msg.color;
        h.ctx.fillRect(msg.x, msg.y, 1, 1);
      }
    },
    applyOpts(h, win) {
      if (win.opts && win.opts.bg_color) h.body.style.background = win.opts.bg_color;
    },
  };

// ── spacer: canned ascii/ansi animations ────────────────────────────
  const BOOTLOG_LINES = [
'Starting systemd-udevd version 255.4-1-arch',
'/dev/nvme0n1p2: clean, 214580/19660800 files, 4120932/78643200 blocks',
'[  OK  ] Started Dispatch Password Requests to Console Directory Watch.',
'[  OK  ] Reached target Local Encrypted Volumes.',
'[  OK  ] Reached target Path Units.',
'[  OK  ] Reached target Remote File Systems.',
'[  OK  ] Reached target Slice Units.',
'[  OK  ] Reached target Swaps.',
'[  OK  ] Listening on Device-mapper event daemon Socket.',
'[  OK  ] Listening on LVM2 poll daemon Socket.',
'[  OK  ] Listening on Process Core Dump Socket.',
'[  OK  ] Listening on initctl Compatibility Named Pipe.',
'[  OK  ] Listening on Journal Socket (/dev/log).',
'[  OK  ] Listening on Journal Socket.',
'[  OK  ] Listening on udev Control Socket.',
'[  OK  ] Listening on udev Kernel Socket.',
'         Starting Journal Service...',
'         Starting Load Kernel Modules...',
'         Starting Remount Root and Kernel File Systems...',
'         Starting Coldplug all udev Devices...',
'[  OK  ] Started Journal Service.',
'[  OK  ] Finished Remount Root and Kernel File Systems.',
'         Starting Flush Journal to Persistent Storage...',
'[  OK  ] Finished Load Kernel Modules.',
'         Starting Apply Kernel Variables...',
'[  OK  ] Finished Flush Journal to Persistent Storage.',
'[  OK  ] Finished Apply Kernel Variables.',
'[  OK  ] Finished Coldplug all udev Devices.',
'         Starting Helper to synchronize boot up for ifupdown...',
'[  OK  ] Finished Helper to synchronize boot up for ifupdown.',
'[  OK  ] Reached target Preparation for Network.',
'         Starting Monitoring of LVM2 mirrors, snapshot etc. using dmeventd or progress polling...',
'[  OK  ] Finished Monitoring of LVM2 mirrors, snapshot etc. using dmeventd or progress polling.',
'[  OK  ] Reached target Local File Systems (Pre).',
'         Mounting /boot...',
'         Mounting /tmp...',
'[  OK  ] Mounted /boot.',
'[  OK  ] Mounted /tmp.',
'[  OK  ] Reached target Local File Systems.',
'         Starting Create Volatile Files and Directories...',
'         Starting Security Auditing Service...',
'[  OK  ] Finished Security Auditing Service.',
'[  OK  ] Finished Create Volatile Files and Directories.',
'         Starting Network Time Synchronization...',
'         Starting Update UTMP about System Boot/Shutdown...',
'[  OK  ] Finished Update UTMP about System Boot/Shutdown.',
'[  OK  ] Started Network Time Synchronization.',
'[  OK  ] Reached target System Time Set.',
'[  OK  ] Reached target System Initialization.',
'[  OK  ] Started Daily Cleanup of Temporary Directories.',
'[  OK  ] Reached target Timer Units.',
'[  OK  ] Listening on D-Bus System Message Bus Socket.',
'[  OK  ] Reached target Socket Units.',
'[  OK  ] Reached target Basic System.',
'         Starting D-Bus System Message Bus...',
'         Starting User Login Management...',
'[  OK  ] Started D-Bus System Message Bus.',
'[  OK  ] Started User Login Management.',
'[  OK  ] Reached target Multi-User System.',
'[  OK  ] Reached target Graphical Interface.',
'',
'Arch Linux 6.8.9-arch1-1 (tty1)',
'',
'archlinux login:',
  ];

  // scroller message pool, keyed by a derived stream state. rather than
  // requiring a separate manually-toggled field, this reads streamd's
  // actual live broadcasts: `status` (free text set via the control panel
  // / !panel-style commands, e.g. "starting soon", "brb", "playing: X") and
  // `scene` ("live" vs anything else). onState('status', ...) and
  // onState('scene', ...) below keep h.liveStatus / h.liveScene current,
  // the same way the now_playing/status panels already track state off
  // these same broadcasts. opts.spacer_state, if explicitly set on the
  // window, overrides the derived value — useful for forcing a state for
  // testing without waiting for the real status to change.
  const SCROLLER_DEFAULT_MESSAGES = {
    starting: [
      '  hello!  ',
      '  welcome to the broadcasting equipment software tour  ',
      '  created by flowerco  ',
      '  let\'s get this started  ',
      '  let\'s get this show on the road  ',
      '  we\'re on air  ',
      '  IT\'S TV TIME!  ',
      ' starting...  ',
      ' peak incoming... ',
      '  no microphone today, or any day really  ',
      '  THE STREAMER WILL NEVER START NOOOO  ',
    ],
    brb: [
      '  brb  ',
      '  quick break  ',
      '  THE STREAMER HAS ABANDONED US NOOOO  ',
      '  DON\'T TOUCH THAT DIAL!  ',
      '  let\'s play Words on Stream  ',
      '  while waiting, go follow @vucci_vt, @suridarkov, @niskavt, @xniyuki, and @faenilia  ',
      '  THE STREAMERS NEVER COMING BACK NOOOO  ',
    ],
    playing: [
      '  thanks for watching!  ',
      '  say hi in chat  ',
      '  you\'re still watching, right? ',
      '  provided in part by flowerco  ',
      '  provided in part by anonymous donors  ',
      '  entirely funded by flowerco, actually ',
      '  do not expect me to be good at any games ',
      '  you know, we never actually figured out what those squares and circles mean...  ',
      '  i don\'t know what\'s going on either  ',
    ],
    ending: [
      '  goodbye guys!  ',
      '  thanks for hanging out today  ',
      '  see you next time!  ',
      '  fiducia\'s at the door  ',
      '  THE STREAMER HATES US  ',
    ],
    default: [
      '  i don\'t know what\'s going on right now  ',
    ],
  };


  // stylized text renderers for the scroller. each takes (ctx, text, x, y,
  // fontPx, color, t) and is responsible for drawing one frame's worth of
  // scrolling text at the given baseline position. keeping these as
  // pluggable functions (rather than branching inline in the scroller case)
  // makes it simple to add more styles later.
  const SCROLLER_STYLES = {
    // plain sine wave, per-character vertical offset (the original look)
    sine(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < text.length; i++) {
        const cx = x + i * charW;
        const cy = y + Math.sin((cx * 0.04) + t * 0.08) * (fontPx * 0.9);
        ctx.fillText(text[i], cx, cy);
      }
    },
    // flat, no wave — clean marquee-style scroll
    flat(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
    },
    // bounce: each character bobs independently, out of phase
    bounce(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < text.length; i++) {
        const cx = x + i * charW;
        const cy = y - Math.abs(Math.sin(t * 0.12 + i * 0.5)) * (fontPx * 0.8);
        ctx.fillText(text[i], cx, cy);
      }
    },
    // rainbow: sine wave + per-character hue cycling (color arg becomes a
    // base saturation/lightness rather than a fixed hex)
    rainbow(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < text.length; i++) {
        const cx = x + i * charW;
        const cy = y + Math.sin((cx * 0.04) + t * 0.08) * (fontPx * 0.9);
        const hue = (t * 2 + i * 18) % 360;
        ctx.fillStyle = `hsl(${hue}, 85%, 60%)`;
        ctx.fillText(text[i], cx, cy);
      }
    },
    // glitch: mostly static position, occasional per-character jitter +
    // color flicker, CRT-ish
    glitch(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < text.length; i++) {
        const cx = x + i * charW;
        const jitter = Math.random() > 0.94 ? (Math.random() - 0.5) * fontPx * 0.6 : 0;
        const jx = Math.random() > 0.97 ? (Math.random() - 0.5) * 4 : 0;
        ctx.fillStyle = Math.random() > 0.9 ? '#ffffff' : color;
        ctx.fillText(text[i], cx + jx, y + jitter);
      }
    },
    // banner: each character drawn as a chunky ascii-art block letter using
    // a tiny built-in 5-row bitmap font, rather than the browser's font
    // rendering — gives a proper "ascii art marquee" look instead of just
    // colored text. falls back to a filled block for characters with no
    // glyph defined (keeps unknown punctuation visible rather than blank).
    banner(ctx, text, x, y, fontPx, color, t, charW) {
      const cell = Math.max(3, Math.floor(fontPx / 6));
      const glyphW = 5, glyphH = 5;
      const stepW = (glyphW + 1) * cell;
      ctx.fillStyle = color;
      for (let i = 0; i < text.length; i++) {
        const glyph = ASCII_BANNER_FONT[text[i].toUpperCase()] || ASCII_BANNER_FONT['?'];
        const gx = x + i * stepW;
        if (gx > -stepW && gx < 4000) {
          for (let row = 0; row < glyphH; row++) {
            const bits = glyph[row] || '';
            for (let col = 0; col < glyphW; col++) {
              if (bits[col] === '1') {
                ctx.fillRect(gx + col * cell, y - (glyphH * cell) / 2 + row * cell, cell - 1, cell - 1);
              }
            }
          }
        }
      }
    },
    // crt: flat scroll with a faint scanline pattern and a subtle red/cyan
    // channel offset ghost, mimicking an old CRT/terminal display
    crt(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff3b3b';
      ctx.fillText(text, x - 2, y);
      ctx.fillStyle = '#3bdfff';
      ctx.fillText(text, x + 2, y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      // scanlines across just the text's vertical band
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      const bandTop = y - fontPx * 0.7, bandBottom = y + fontPx * 0.7;
      for (let sy = bandTop; sy < bandBottom; sy += 3) {
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(4000, sy);
        ctx.stroke();
      }
    },
    // ascii-shade: renders each character position as a density-ramped
    // ascii block (░▒▓█ style) whose density follows the sine wave height —
    // reads as a wave made of literal ascii shading characters rather than
    // moving text glyphs, distinct from the plain 'sine' style
    ascii_shade(ctx, text, x, y, fontPx, color, t, charW) {
      const ramp = ' .:-=+*#%@';
      ctx.font = `${fontPx}px monospace`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < text.length; i++) {
        const cx = x + i * charW;
        const wave = Math.sin((cx * 0.05) + t * 0.1);
        const density = Math.floor(((wave + 1) / 2) * (ramp.length - 1));
        const ch = text[i] === ' ' ? ' ' : ramp[density];
        const cy = y + wave * (fontPx * 0.5);
        ctx.fillText(ch, cx, cy);
      }
    },
  };

  // minimal 5x5-bit ascii-art font for the 'banner' scroller style. only
  // covers uppercase A-Z, 0-9, space, and a fallback glyph — enough for
  // short marquee messages. each string is one row, '1' = filled cell.
  const ASCII_BANNER_FONT = {
    ' ': ['00000','00000','00000','00000','00000'],
    'A': ['01110','10001','11111','10001','10001'],
    'B': ['11110','10001','11110','10001','11110'],
    'C': ['01111','10000','10000','10000','01111'],
    'D': ['11110','10001','10001','10001','11110'],
    'E': ['11111','10000','11110','10000','11111'],
    'F': ['11111','10000','11110','10000','10000'],
    'G': ['01111','10000','10011','10001','01111'],
    'H': ['10001','10001','11111','10001','10001'],
    'I': ['11111','00100','00100','00100','11111'],
    'J': ['00001','00001','00001','10001','01110'],
    'K': ['10001','10010','11100','10010','10001'],
    'L': ['10000','10000','10000','10000','11111'],
    'M': ['10001','11011','10101','10001','10001'],
    'N': ['10001','11001','10101','10011','10001'],
    'O': ['01110','10001','10001','10001','01110'],
    'P': ['11110','10001','11110','10000','10000'],
    'Q': ['01110','10001','10101','10010','01101'],
    'R': ['11110','10001','11110','10010','10001'],
    'S': ['01111','10000','01110','00001','11110'],
    'T': ['11111','00100','00100','00100','00100'],
    'U': ['10001','10001','10001','10001','01110'],
    'V': ['10001','10001','10001','01010','00100'],
    'W': ['10001','10001','10101','11011','10001'],
    'X': ['10001','01010','00100','01010','10001'],
    'Y': ['10001','01010','00100','00100','00100'],
    'Z': ['11111','00010','00100','01000','11111'],
    '0': ['01110','10011','10101','11001','01110'],
    '1': ['00100','01100','00100','00100','01110'],
    '2': ['01110','10001','00010','00100','11111'],
    '3': ['11110','00001','00110','00001','11110'],
    '4': ['00010','00110','01010','11111','00010'],
    '5': ['11111','10000','11110','00001','11110'],
    '6': ['00110','01000','11110','10001','01110'],
    '7': ['11111','00001','00010','00100','00100'],
    '8': ['01110','10001','01110','10001','01110'],
    '9': ['01110','10001','01111','00001','01100'],
    '!': ['00100','00100','00100','00000','00100'],
    '.': ['00000','00000','00000','00000','00100'],
    ',': ['00000','00000','00000','00100','01000'],
    '\'': ['00100','00100','00000','00000','00000'],
    '-': ['00000','00000','11111','00000','00000'],
    ':': ['00000','00100','00000','00100','00000'],
    '?': ['01110','10001','00110','00000','00100'],
  };

  function _pickScrollerMessage(h) {
    const opts = (h.win && h.win.opts) || {};
    const manualState = opts.spacer_state && opts.spacer_state !== 'default' ? opts.spacer_state : null;
    const state = manualState || _deriveScrollerState(h);
    const custom = opts.spacer_scroller_messages;
    const pool = (custom && custom[state] && custom[state].length) ? custom[state]
      : (SCROLLER_DEFAULT_MESSAGES[state] || SCROLLER_DEFAULT_MESSAGES.default);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // maps streamd's live `status` text + `scene` into one of our state
  // buckets. status is free text the streamer types (via the control
  // panel's status field, or the built-in presets: "starting soon", "be
  // right back"/"brb", "just chatting", "playing: <game>", "ending soon",
  // "offline"), so this does simple substring matching rather than
  // expecting an enum — mirrors how the pngtuber panel already infers mood
  // off the same status string (see panels.js resolvePngtuberState).
  function _deriveScrollerState(h) {
    const scene = (h.liveScene || '').toLowerCase().trim();
    const status = (h.liveStatus || '').toLowerCase().trim();

    // streamd sends a normalized `scene` alongside the free-form `status`.
    // Prefer the scene when it is known, because it reflects the actual
    // mode transition the daemon just published; fall back to status text
    // only for older or manually-set values that never send a scene.
    if (scene === 'starting' || scene === 'brb' || scene === 'ending' || scene === 'playing') {
      return scene;
    }

    if (status.includes('starting')) return 'starting';
    if (status.includes('brb') || status.includes('be right back') || status.includes('technical')) return 'brb';
    if (status.includes('ending')) return 'ending';
    if (status.includes('playing:') || status.includes('playing') || status.includes('just chatting') || status.includes('live')) return 'playing';
    return 'default';
  }
  const TYPEWRITER_LINES = [
'> connecting to relay... ok',
'> subscribed: chat, follows, redeems',
'[info] frame budget: 3.2ms / 16.6ms',
'[info] compositor: 3 layers active',
'GET /api/state 200 4ms',
'GET /api/state 200 3ms',
'> heartbeat ok',
'[warn] retrying upstream in 2s',
'> reconnected',
'POST /webhook/redeem 200 11ms',
'[info] gc: minor pause 0.4ms',
'> cache hit ratio: 0.94',
'[info] scene switch -> just chatting',
'> tick 60fps stable',
'GET /api/stats 200 2ms',
'[info] audio meter: -18dB',
'> idle',
'> awaiting input_',
  ];

  function _escapeSpacerHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── color helpers ────────────────────────────────────────────────────
  // spacer_color (from win.opts) is the single source of truth for an
  // animation's accent color. each kind has a sane default so old saved
  // layouts (no spacer_color set) still render with their original look.
  const SPACER_COLOR_DEFAULTS = {
    bootlog: '#d8dee2',
    matrix: '#00ff66',
    static: '#ffffff',
    fire: '#ff8c1a',
    starfield: '#5e9dff',
    oscilloscope: '#00ffaa',
    plasma: '#ff2fd6',
    rain: '#5ec8ff',
    dna: '#7dffb0',
    pipes: '#ff9f2f',
    life: '#4ade80',
    typewriter: '#4ade80',
    waveform: '#00e0ff',
    metaballs: '#ff4fa3',
    tunnel: '#00d4ff',
    rotozoom: '#ffcf40',
    copperbars: '#ff6b6b',
    scroller: '#4ade80',
    voronoi: '#7d6bff',
    wobble: '#ff6bd6',
    lens: '#ffe27a',
    floorgrid: '#39ff9e',
    bump: '#8f9dff',
    wireframe: '#5ef2ff',
  };

  // vertex/edge sets for the wireframe kind. plain unit cube (±1 on each
  // axis) plus a couple of alternates the user can pick via
  // opts.spacer_wireframe_shape.
  const WIREFRAME_SHAPES = {
    cube: {
      verts: [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
      ],
      edges: [
        [0,1],[1,2],[2,3],[3,0],
        [4,5],[5,6],[6,7],[7,4],
        [0,4],[1,5],[2,6],[3,7],
      ],
    },
    pyramid: {
      verts: [
        [0, -1.3, 0],
        [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
      ],
      edges: [
        [0,1],[0,2],[0,3],[0,4],
        [1,2],[2,3],[3,4],[4,1],
      ],
    },
    octahedron: {
      verts: [
        [0, -1.3, 0], [0, 1.3, 0],
        [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
      ],
      edges: [
        [0,2],[0,3],[0,4],[0,5],
        [1,2],[1,3],[1,4],[1,5],
        [2,3],[3,4],[4,5],[5,2],
      ],
    },
  };

  function _hexToRgb(hex) {
    let h = (hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return { r: 0, g: 255, b: 102 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function _spacerColor(h) {
    return (h.win && h.win.opts && h.win.opts.spacer_color) || SPACER_COLOR_DEFAULTS[h.kind] || '#00ff66';
  }

  function _rgba(hex, a) {
    const { r, g, b } = _hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  // shift hue-ish by mixing toward a secondary tone derived from the base
  // color (used by plasma/fire for a gradient feel without hardcoding hues)
  function _shade(hex, factor) {
    const { r, g, b } = _hexToRgb(hex);
    const f = Math.max(0, Math.min(2, factor));
    const mix = (c) => Math.max(0, Math.min(255, Math.round(c * f)));
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }

  const spacer = {
    mount(body, win) {
      body.classList.add('wm-term', 'spacer-body');
      const kind = (win && win.opts && win.opts.spacer_kind) || 'bootlog';
      const canvasEl = document.createElement('canvas');
      const pre = document.createElement('div');
      pre.className = 'spacer-pre';
      body.appendChild(canvasEl);
      body.appendChild(pre);

      // each spacer instance gets its own independent timer/raf/animation
      // state object (h) — previously a shared module-level `t`/`modeData`
      // pattern meant a second spacer window's animation loop could stomp
      // on the first one's canvas sizing/state. keeping everything on `h`
      // (already the pattern here) plus giving each instance its own
      // canvas element (also already true — each mount() call makes a new
      // <canvas>) means multiple spacer windows now animate independently.
      const h = { kind, win, canvas: canvasEl, pre, raf: null, timer: null, lineIdx: 0, cleanups: [], body, modeData: {}, t: 0, liveStatus: '', liveScene: '' };
      startSpacer(h);
      return h;
    },
    onState(h, key, msg) {
      if (key === 'status') {
        h.liveStatus = (msg && msg.value) || '';
        return;
      }
      if (key === 'scene') {
        h.liveScene = (msg && msg.value) || '';
        return;
      }
      if (msg && msg.spacer_kind && msg.spacer_kind !== h.kind) {
        h.kind = msg.spacer_kind;
        this.unmount(h);
        startSpacer(h);
      }
    },
    applyOpts(h, win) {
      h.win = win;
      const kind = (win.opts && win.opts.spacer_kind) || 'bootlog';
      if (kind !== h.kind) {
        h.kind = kind;
        spacer.unmount(h);
        startSpacer(h);
      }
      // color-only changes don't need a full restart — modeData persists
      // (matrix trails, starfield positions, etc keep animating smoothly)
    },
    unmount(h) {
      if (h.raf) cancelAnimationFrame(h.raf);
      if (h.timer) clearTimeout(h.timer);
      h.raf = null;
      h.timer = null;
      if (h.cleanups) {
        h.cleanups.forEach(fn => fn());
        h.cleanups = [];
      }
    }
  };

  function startSpacer(h) {
    h.cleanups = [];
    h.modeData = {};
    h.t = 0;

    if (h.kind === 'bootlog' || h.kind === 'typewriter') {
      h.pre.style.display = 'block';
      h.canvas.style.display = 'none';
      h.pre.style.color = _spacerColor(h);
      const lines = h.kind === 'typewriter' ? TYPEWRITER_LINES : BOOTLOG_LINES;
      const tick = () => {
        h.pre.style.color = _spacerColor(h);
        const n = Math.min(lines.length, h.lineIdx + 1);
        h.pre.innerHTML =
          lines.slice(0, n)
            .map(l => `<div class="line">${_escapeSpacerHtml(l)}</div>`)
            .join('') + '<span class="wm-cursor" style="background:' + _spacerColor(h) + ';">&nbsp;</span>';
        h.lineIdx = (h.lineIdx + 1) % (lines.length + 3);
        h.timer = setTimeout(tick, h.kind === 'typewriter' ? 450 : 600);
      };
      tick();
      return;
    }

    h.pre.style.display = 'none';
    h.canvas.style.display = 'block';
    const ctx = h.canvas.getContext('2d');

    function resize() {
      const rect = h.canvas.parentElement ? h.canvas.parentElement.getBoundingClientRect() : { width: 300, height: 200 };
      h.canvas.width = rect.width || 300;
      h.canvas.height = rect.height || 200;
    }
    resize();

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    h.cleanups.push(() => window.removeEventListener('resize', onResize));

    const modeData = h.modeData;

    if (h.kind === 'matrix') {
      const chars = '01アイウエオカキクケコサシスセソ$#@%&*';
      let cols = new Array(Math.floor(h.canvas.width / 14)).fill(0);
      modeData.matrix = { chars, cols };
    } else if (h.kind === 'starfield') {
      const stars = Array.from({ length: 150 }, () => ({
        x: (Math.random() - 0.5) * 1000, y: (Math.random() - 0.5) * 1000, z: Math.random() * 1000
      }));
      modeData.stars = stars;
    } else if (h.kind === 'fire') {
      modeData.fireCols = Math.floor(h.canvas.width / 4);
      modeData.fireRows = Math.floor(h.canvas.height / 4);
      modeData.fireBuf = new Array(modeData.fireCols * modeData.fireRows).fill(0);
    } else if (h.kind === 'rain') {
      const cols = Math.max(1, Math.floor(h.canvas.width / 6));
      modeData.rain = Array.from({ length: cols }, () => ({
        y: Math.random() * -500,
        speed: 4 + Math.random() * 8,
        len: 10 + Math.random() * 20,
      }));
    } else if (h.kind === 'dna') {
      modeData.dna = { angle: 0 };
    } else if (h.kind === 'pipes') {
      modeData.pipes = { walkers: [], cell: 10, grid: null, cols: 0, rows: 0 };
    } else if (h.kind === 'life') {
      const cell = 6;
      const cols = Math.max(4, Math.floor(h.canvas.width / cell));
      const rows = Math.max(4, Math.floor(h.canvas.height / cell));
      const cells = new Uint8Array(cols * rows);
      for (let i = 0; i < cells.length; i++) cells[i] = Math.random() > 0.72 ? 1 : 0;
      modeData.life = { cell, cols, rows, cells, genTick: 0 };
    } else if (h.kind === 'waveform') {
      const bars = 48;
      modeData.waveform = { bars, phases: Array.from({ length: bars }, () => Math.random() * Math.PI * 2) };
    } else if (h.kind === 'metaballs') {
      modeData.metaballs = {
        balls: Array.from({ length: 5 }, () => ({
          x: Math.random(), y: Math.random(),
          vx: (Math.random() - 0.5) * 0.006, vy: (Math.random() - 0.5) * 0.006,
          r: 0.12 + Math.random() * 0.08,
        })),
      };
    } else if (h.kind === 'tunnel') {
      modeData.tunnel = { angle: 0 };
    } else if (h.kind === 'rotozoom') {
      modeData.rotozoom = { angle: 0 };
    } else if (h.kind === 'copperbars') {
      modeData.copperbars = { bars: 6 };
    } else if (h.kind === 'scroller') {
      const manualState = (h.win && h.win.opts && h.win.opts.spacer_state && h.win.opts.spacer_state !== 'default') ? h.win.opts.spacer_state : null;
      modeData.scroller = { x: 0, text: _pickScrollerMessage(h), lastState: (manualState || _deriveScrollerState(h)) };
    } else if (h.kind === 'voronoi') {
      modeData.voronoi = {
        cells: Array.from({ length: 10 }, () => ({
          x: Math.random(), y: Math.random(),
          vx: (Math.random() - 0.5) * 0.004, vy: (Math.random() - 0.5) * 0.004,
        })),
      };
    } else if (h.kind === 'wobble') {
      modeData.wobble = { rings: 6 };
    } else if (h.kind === 'lens') {
      modeData.lens = { angle: 0 };
    } else if (h.kind === 'floorgrid') {
      modeData.floorgrid = {};
    } else if (h.kind === 'bump') {
      modeData.bump = { lightAngle: 0 };
    } else if (h.kind === 'wireframe') {
      modeData.wireframe = { ax: 0, ay: 0, az: 0 };
    }

    function frame() {
      h.t += 1;
      const w = h.canvas.width;
      const hg = h.canvas.height;
      const color = _spacerColor(h);

      switch (h.kind) {
        case 'matrix': {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
          ctx.fillRect(0, 0, w, hg);
          ctx.fillStyle = color;
          ctx.font = '13px monospace';
          const chars = modeData.matrix.chars;
          if (modeData.matrix.cols.length !== Math.floor(w / 14)) {
            modeData.matrix.cols = new Array(Math.floor(w / 14)).fill(0);
          }
          modeData.matrix.cols.forEach((y, i) => {
            const ch = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(ch, i * 14, y);
            if (y > hg && Math.random() > 0.975) modeData.matrix.cols[i] = 0;
            else modeData.matrix.cols[i] = y + 14;
          });
          break;
        }
        case 'static': {
          const { r, g, b } = _hexToRgb(color);
          const img = ctx.createImageData(w, hg);
          for (let i = 0; i < img.data.length; i += 4) {
            const v = Math.random();
            img.data[i] = r * v;
            img.data[i + 1] = g * v;
            img.data[i + 2] = b * v;
            img.data[i + 3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          break;
        }
        case 'starfield': {
          ctx.fillStyle = '#000005';
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2, cy = hg / 2;
          const { r, g, b } = _hexToRgb(color);
          modeData.stars.forEach(s => {
            s.z -= 4;
            if (s.z <= 0) {
              s.z = 1000;
              s.x = (Math.random() - 0.5) * 1000;
              s.y = (Math.random() - 0.5) * 1000;
            }
            const k = 256 / s.z;
            const px = s.x * k + cx, py = s.y * k + cy;
            if (px >= 0 && px < w && py >= 0 && py < hg) {
              const size = Math.max(0.5, (1 - s.z / 1000) * 3);
              const shade = (1 - s.z / 1000);
              ctx.fillStyle = `rgb(${Math.round(r * shade + 255 * (1 - shade) * 0.2)},${Math.round(g * shade + 255 * (1 - shade) * 0.2)},${Math.round(b * shade + 255 * (1 - shade) * 0.2)})`;
              ctx.fillRect(px, py, size, size);
            }
          });
          break;
        }
        case 'oscilloscope': {
          ctx.fillStyle = 'rgba(0, 10, 5, 0.2)';
          ctx.fillRect(0, 0, w, hg);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          const cy = hg / 2;
          for (let x = 0; x < w; x += 2) {
            const y = cy + Math.sin(x * 0.02 + h.t * 0.08) * 30 + Math.cos(x * 0.05 - h.t * 0.1) * 15 + (Math.random() - 0.5) * 4;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          break;
        }
        case 'fire': {
          const cols = modeData.fireCols || Math.floor(w / 4);
          const rows = modeData.fireRows || Math.floor(hg / 4);
          const buf = modeData.fireBuf || new Array(cols * rows).fill(0);
          for (let c = 0; c < cols; c++) buf[(rows - 1) * cols + c] = Math.random() > 0.4 ? 255 : 0;
          for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols; c++) {
              const idx = r * cols + c;
              const below = (r + 1) * cols + c;
              const decay = Math.floor(Math.random() * 12);
              buf[idx] = Math.max(0, (buf[below] || 0) - decay);
            }
          }
          const pw = Math.ceil(w / cols), ph = Math.ceil(hg / rows);
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const val = buf[r * cols + c];
              if (val > 0) {
                const t2 = val / 255;
                ctx.fillStyle = `rgb(${Math.min(255, Math.round(br * t2 + 255 * (1 - t2) * (t2)))},${Math.round(bg * t2)},${Math.round(bb * t2 * 0.5)})`;
                ctx.fillRect(c * pw, r * ph, pw, ph);
              }
            }
          }
          modeData.fireBuf = buf;
          break;
        }
        case 'plasma': {
          // downsampled plasma field for perf, upscaled via fillRect blocks
          const block = 6;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          const time = h.t * 0.04;
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const v = Math.sin(xx * 0.15 + time) + Math.sin(yy * 0.15 + time * 1.3) +
                        Math.sin((xx + yy) * 0.1 + time * 0.7) + Math.sin(Math.sqrt(xx * xx + yy * yy) * 0.12 - time);
              const t2 = (v + 4) / 8; // normalize 0..1
              ctx.fillStyle = `rgb(${Math.round(br * t2)},${Math.round(bg * (1 - t2) + bg * t2 * 0.3)},${Math.round(bb * (1 - t2 * 0.5))})`;
              ctx.fillRect(xx * block, yy * block, block, block);
            }
          }
          break;
        }
        case 'rain': {
          ctx.fillStyle = 'rgba(3, 5, 8, 0.25)';
          ctx.fillRect(0, 0, w, hg);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          const drops = modeData.rain;
          if (drops.length !== Math.max(1, Math.floor(w / 6))) {
            const target = Math.max(1, Math.floor(w / 6));
            while (drops.length < target) drops.push({ y: Math.random() * -500, speed: 4 + Math.random() * 8, len: 10 + Math.random() * 20 });
            drops.length = target;
          }
          drops.forEach((d, i) => {
            const x = i * 6 + 3;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(x, d.y);
            ctx.lineTo(x, d.y + d.len);
            ctx.stroke();
            d.y += d.speed;
            if (d.y > hg + d.len) { d.y = -d.len - Math.random() * 200; d.speed = 4 + Math.random() * 8; }
          });
          ctx.globalAlpha = 1;
          break;
        }
        case 'dna': {
          ctx.fillStyle = 'rgba(2, 4, 6, 0.3)';
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2;
          const amp = Math.min(w * 0.28, 80);
          const steps = 40;
          modeData.dna.angle += 0.05;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          for (let i = 0; i < steps; i++) {
            const y = (i / steps) * hg;
            const phase = modeData.dna.angle + i * 0.35;
            const x1 = cx + Math.sin(phase) * amp;
            const x2 = cx + Math.sin(phase + Math.PI) * amp;
            const depth1 = (Math.cos(phase) + 1) / 2;
            const depth2 = (Math.cos(phase + Math.PI) + 1) / 2;
            if (i % 3 === 0) {
              ctx.strokeStyle = `rgba(${br},${bg},${bb},${0.25 + 0.25 * Math.min(depth1, depth2)})`;
              ctx.lineWidth = 1.5;
              ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
            }
            ctx.fillStyle = `rgba(${br},${bg},${bb},${0.4 + 0.6 * depth1})`;
            ctx.beginPath(); ctx.arc(x1, y, 3 + depth1 * 2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = `rgba(${br},${bg},${bb},${0.4 + 0.6 * depth2})`;
            ctx.beginPath(); ctx.arc(x2, y, 3 + depth2 * 2, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'pipes': {
          const cell = modeData.pipes.cell;
          if (!modeData.pipes.grid || modeData.pipes.cols !== Math.floor(w / cell) || modeData.pipes.rows !== Math.floor(hg / cell)) {
            modeData.pipes.cols = Math.max(2, Math.floor(w / cell));
            modeData.pipes.rows = Math.max(2, Math.floor(hg / cell));
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, hg);
            modeData.pipes.walkers = [];
          }
          if (modeData.pipes.walkers.length < 3 && Math.random() > 0.9) {
            modeData.pipes.walkers.push({
              x: Math.floor(Math.random() * modeData.pipes.cols),
              y: Math.floor(Math.random() * modeData.pipes.rows),
              dir: Math.floor(Math.random() * 4),
              life: 200 + Math.random() * 300,
              hue: Math.random(),
            });
          }
          ctx.fillStyle = 'rgba(0,0,0,0.02)';
          ctx.fillRect(0, 0, w, hg);
          modeData.pipes.walkers = modeData.pipes.walkers.filter(walker => {
            walker.life -= 1;
            if (walker.life <= 0) return false;
            if (Math.random() > 0.85) walker.dir = Math.floor(Math.random() * 4);
            const dx = [1, -1, 0, 0][walker.dir], dy = [0, 0, 1, -1][walker.dir];
            walker.x = (walker.x + dx + modeData.pipes.cols) % modeData.pipes.cols;
            walker.y = (walker.y + dy + modeData.pipes.rows) % modeData.pipes.rows;
            ctx.fillStyle = _shade(color, 0.6 + walker.hue * 0.8);
            ctx.fillRect(walker.x * cell, walker.y * cell, cell - 1, cell - 1);
            return true;
          });
          break;
        }
        case 'life': {
          const L = modeData.life;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          L.genTick++;
          if (L.genTick % 6 === 0) {
            const next = new Uint8Array(L.cells.length);
            for (let y = 0; y < L.rows; y++) {
              for (let x = 0; x < L.cols; x++) {
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = (x + dx + L.cols) % L.cols, ny = (y + dy + L.rows) % L.rows;
                  n += L.cells[ny * L.cols + nx];
                }
                const alive = L.cells[y * L.cols + x];
                next[y * L.cols + x] = alive ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
              }
            }
            // reseed if the board has died out or stabilized to near-empty
            let count = 0; for (let i = 0; i < next.length; i++) count += next[i];
            if (count < L.cells.length * 0.02) {
              for (let i = 0; i < next.length; i++) next[i] = Math.random() > 0.75 ? 1 : 0;
            }
            L.cells = next;
          }
          ctx.fillStyle = color;
          for (let y = 0; y < L.rows; y++) {
            for (let x = 0; x < L.cols; x++) {
              if (L.cells[y * L.cols + x]) ctx.fillRect(x * L.cell, y * L.cell, L.cell - 1, L.cell - 1);
            }
          }
          break;
        }
        case 'waveform': {
          ctx.fillStyle = 'rgba(2,4,6,0.35)';
          ctx.fillRect(0, 0, w, hg);
          const WF = modeData.waveform;
          const barW = w / WF.bars;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          for (let i = 0; i < WF.bars; i++) {
            WF.phases[i] += 0.05 + (i % 5) * 0.01;
            const amp = (Math.sin(WF.phases[i]) * 0.5 + 0.5) * (0.4 + 0.6 * Math.sin(h.t * 0.02 + i * 0.3) ** 2);
            const barH = amp * hg * 0.85;
            const alpha = 0.5 + amp * 0.5;
            ctx.fillStyle = `rgba(${br},${bg},${bb},${alpha})`;
            ctx.fillRect(i * barW + 1, hg - barH, barW - 2, barH);
          }
          break;
        }
        case 'metaballs': {
          // downsampled scalar-field metaballs — classic demoscene "blob"
          // effect, computed on a coarse grid then drawn as blocks for perf
          const block = 5;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const balls = modeData.metaballs.balls;
          balls.forEach(b => {
            b.x += b.vx; b.y += b.vy;
            if (b.x < 0 || b.x > 1) b.vx *= -1;
            if (b.y < 0 || b.y > 1) b.vy *= -1;
          });
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          for (let yy = 0; yy < rows; yy++) {
            const py = yy / rows;
            for (let xx = 0; xx < cols; xx++) {
              const px = xx / cols;
              let sum = 0;
              for (let i = 0; i < balls.length; i++) {
                const b = balls[i];
                const dx = px - b.x, dy = py - b.y;
                sum += (b.r * b.r) / (dx * dx + dy * dy + 0.0001);
              }
              if (sum > 1) {
                const t2 = Math.min(1, (sum - 1) / 2);
                ctx.fillStyle = `rgba(${br},${bg},${bb},${0.35 + t2 * 0.65})`;
                ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
              }
            }
          }
          break;
        }
        case 'tunnel': {
          // texture-mapped tunnel via angle/depth lookup per downsampled pixel
          const block = 4;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const cx = w / 2, cy = hg / 2;
          modeData.tunnel.angle += 0.02;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const dx = xx * block - cx, dy = yy * block - cy;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
              const ang = Math.atan2(dy, dx);
              const depth = (1 / dist) * 260 + h.t * 0.06;
              const ring = (Math.sin(depth) + Math.sin(ang * 6 + modeData.tunnel.angle)) * 0.5;
              const t2 = (ring + 1) / 2;
              ctx.fillStyle = `rgb(${Math.round(br * t2)},${Math.round(bg * t2)},${Math.round(bb * t2)})`;
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'rotozoom': {
          // checkerboard rotated+zoomed each frame — classic rotozoomer.
          // fixed: solid two-tone squares (no alpha blending, which read as
          // muddy) and a checker size that scales with canvas size so it
          // stays readable at small window dimensions instead of aliasing
          // into noise.
          const block = 4;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          modeData.rotozoom.angle += 0.012;
          const zoom = 1.1 + Math.sin(h.t * 0.015) * 0.35;
          const ca = Math.cos(modeData.rotozoom.angle) * zoom;
          const sa = Math.sin(modeData.rotozoom.angle) * zoom;
          const cx = w / 2, cy = hg / 2;
          const checkSize = Math.max(24, Math.min(w, hg) / 8);
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          const darkR = Math.round(br * 0.15), darkG = Math.round(bg * 0.15), darkB = Math.round(bb * 0.15);
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const px = xx * block - cx, py = yy * block - cy;
              const u = px * ca - py * sa;
              const v = px * sa + py * ca;
              const check = (Math.floor(u / checkSize) + Math.floor(v / checkSize)) % 2 === 0;
              ctx.fillStyle = check ? `rgb(${br},${bg},${bb})` : `rgb(${darkR},${darkG},${darkB})`;
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'copperbars': {
          // classic amiga-style bouncing gradient copper bars
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          const barCount = modeData.copperbars.bars;
          const barH = Math.max(18, hg / 14);
          for (let i = 0; i < barCount; i++) {
            const phase = h.t * 0.04 + i * 0.6;
            const cy = hg / 2 + Math.sin(phase) * (hg / 2 - barH);
            const grad = ctx.createLinearGradient(0, cy - barH / 2, 0, cy + barH / 2);
            grad.addColorStop(0, `rgba(${br},${bg},${bb},0)`);
            grad.addColorStop(0.5, `rgba(${br},${bg},${bb},0.9)`);
            grad.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, cy - barH / 2, w, barH);
          }
          break;
        }
        case 'scroller': {
          // classic sine-wave text scroller (and stylized variants). picks
          // a random message from the pool matching the current
          // spacer_state, and re-picks whenever the state changes or the
          // current message finishes scrolling off — so it never just
          // marches through the list in order.
          ctx.fillStyle = 'rgba(2,4,6,0.3)';
          ctx.fillRect(0, 0, w, hg);
          const S = modeData.scroller;
          const opts = (h.win && h.win.opts) || {};
          const manualState = opts.spacer_state && opts.spacer_state !== 'default' ? opts.spacer_state : null;
          const curState = manualState || _deriveScrollerState(h);
          if (curState !== S.lastState) {
            S.lastState = curState;
            S.text = _pickScrollerMessage(h);
            S.x = w;
          }
          const styleName = opts.spacer_scroller_style || 'sine';
          const styleFn = SCROLLER_STYLES[styleName] || SCROLLER_STYLES.sine;
          const fontPx = Math.max(16, Math.floor(hg * 0.35));
          ctx.font = `${fontPx}px monospace`;
          // banner uses fixed-width ascii-art glyph cells instead of the
          // font's own character metrics, so its scroll speed/wrap math
          // needs a different charW than the text-rendering styles
          const bannerCell = Math.max(3, Math.floor(fontPx / 6));
          const charW = styleName === 'banner' ? (6 * bannerCell) : (ctx.measureText('M').width || 14);
          const cy = hg / 2;
          styleFn(ctx, S.text, S.x, cy, fontPx, color, h.t, charW);
          S.x -= 3;
          const totalW = S.text.length * charW;
          if (S.x < -totalW) {
            S.text = _pickScrollerMessage(h);
            S.x = w;
          }
          break;
        }
        case 'voronoi': {
          // animated voronoi cell diagram — nearest-seed coloring on a
          // downsampled grid, seeds drift slowly
          const block = 6;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const cells = modeData.voronoi.cells;
          cells.forEach(c => {
            c.x += c.vx; c.y += c.vy;
            if (c.x < 0 || c.x > 1) c.vx *= -1;
            if (c.y < 0 || c.y > 1) c.vy *= -1;
          });
          for (let yy = 0; yy < rows; yy++) {
            const py = yy / rows;
            for (let xx = 0; xx < cols; xx++) {
              const px = xx / cols;
              let best = Infinity, bestI = 0;
              for (let i = 0; i < cells.length; i++) {
                const dx = px - cells[i].x, dy = py - cells[i].y;
                const d = dx * dx + dy * dy;
                if (d < best) { best = d; bestI = i; }
              }
              const t2 = bestI / cells.length;
              ctx.fillStyle = _shade(color, 0.4 + t2 * 1.1);
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'wobble': {
          // concentric rings distorted by a moving sine offset — classic
          // "wobbler" effect applied to a plain radial pattern
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2, cy = hg / 2;
          const maxR = Math.sqrt(cx * cx + cy * cy);
          const rings = modeData.wobble.rings;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          ctx.lineWidth = 3;
          for (let i = 0; i < rings * 4; i++) {
            const baseR = (i / (rings * 4)) * maxR;
            const wob = Math.sin(baseR * 0.05 - h.t * 0.06) * 14;
            ctx.strokeStyle = `rgba(${br},${bg},${bb},${0.15 + 0.5 * ((i % 4) / 4)})`;
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(0, baseR + wob), 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case 'lens': {
          // rotating radial "lens flare" style streaks + soft core glow
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2, cy = hg / 2;
          modeData.lens.angle += 0.01;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, hg) * 0.4);
          glow.addColorStop(0, `rgba(${br},${bg},${bb},0.8)`);
          glow.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, w, hg);
          const streaks = 8;
          ctx.lineWidth = 2;
          for (let i = 0; i < streaks; i++) {
            const ang = modeData.lens.angle + (i / streaks) * Math.PI * 2;
            const len = Math.min(w, hg) * (0.3 + 0.15 * Math.sin(h.t * 0.03 + i));
            ctx.strokeStyle = `rgba(${br},${bg},${bb},0.35)`;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
            ctx.stroke();
          }
          break;
        }
        case 'floorgrid': {
          // perspective floor grid receding toward a horizon, classic
          // synthwave/demoscene "3D floor" made of simple horizontal +
          // converging vertical lines (cheap, no real 3D math needed)
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          const horizon = hg * 0.42;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          ctx.strokeStyle = `rgba(${br},${bg},${bb},0.7)`;
          ctx.lineWidth = 1;
          const vCount = 12;
          for (let i = -vCount; i <= vCount; i++) {
            const topX = w / 2 + i * (w / (vCount * 2));
            const spread = i * (w * 0.7);
            ctx.beginPath();
            ctx.moveTo(w / 2 + spread, hg);
            ctx.lineTo(topX, horizon);
            ctx.stroke();
          }
          const hCount = 10;
          const speedOffset = (h.t * 2) % 40;
          for (let j = 0; j < hCount; j++) {
            const t2 = (j * 40 + speedOffset) / (hCount * 40);
            const y = horizon + t2 * t2 * (hg - horizon);
            ctx.globalAlpha = Math.min(1, t2 + 0.15);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'bump': {
          // 2D bump-mapped ripple: a moving light source over a sine
          // height-field, shaded per-cell by the angle to the light
          const block = 6;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          modeData.bump.lightAngle += 0.02;
          const lx = w / 2 + Math.cos(modeData.bump.lightAngle) * w * 0.35;
          const ly = hg / 2 + Math.sin(modeData.bump.lightAngle) * hg * 0.35;
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const px = xx * block, py = yy * block;
              const height = Math.sin(px * 0.05 + h.t * 0.04) * Math.cos(py * 0.05 + h.t * 0.03);
              const dx = (lx - px) / w, dy = (ly - py) / hg;
              const lightDot = Math.max(0, dx * Math.cos(height) + dy * Math.sin(height));
              const shade = 0.15 + lightDot * 0.85;
              ctx.fillStyle = `rgb(${Math.round(br * shade)},${Math.round(bg * shade)},${Math.round(bb * shade)})`;
              ctx.fillRect(px, py, block + 1, block + 1);
            }
          }
          break;
        }
        case 'wireframe': {
          // real 3D wireframe: rotate verts on x/y/z, perspective-project
          // to screen space, draw edges. shape swappable via
          // opts.spacer_wireframe_shape ('cube' | 'pyramid' | 'octahedron').
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
          const opts = (h.win && h.win.opts) || {};
          const shapeName = opts.spacer_wireframe_shape || 'cube';
          const shape = WIREFRAME_SHAPES[shapeName] || WIREFRAME_SHAPES.cube;
          const W = modeData.wireframe;
          W.ax += 0.012; W.ay += 0.018; W.az += 0.006;
          const cosx = Math.cos(W.ax), sinx = Math.sin(W.ax);
          const cosy = Math.cos(W.ay), siny = Math.sin(W.ay);
          const cosz = Math.cos(W.az), sinz = Math.sin(W.az);
          const scale = Math.min(w, hg) * 0.28;
          const cx = w / 2, cy = hg / 2;
          const dist = 4; // camera distance for perspective divide
          const projected = shape.verts.map(([vx, vy, vz]) => {
            // rotate X
            let y1 = vy * cosx - vz * sinx, z1 = vy * sinx + vz * cosx;
            // rotate Y
            let x2 = vx * cosy + z1 * siny, z2 = -vx * siny + z1 * cosy;
            // rotate Z
            let x3 = x2 * cosz - y1 * sinz, y3 = x2 * sinz + y1 * cosz;
            const persp = dist / (dist + z2);
            return { x: cx + x3 * scale * persp, y: cy + y3 * scale * persp, depth: z2 };
          });
          const { r: br, g: bg, b: bb } = _hexToRgb(color);
          shape.edges.forEach(([a, b2]) => {
            const p1 = projected[a], p2 = projected[b2];
            const avgDepth = (p1.depth + p2.depth) / 2;
            const alpha = Math.max(0.25, Math.min(1, 1 - avgDepth * 0.3));
            ctx.strokeStyle = `rgba(${br},${bg},${bb},${alpha})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          });
          // vertex dots, closer ones drawn slightly bigger/brighter
          projected.forEach(p => {
            const alpha = Math.max(0.4, Math.min(1, 1 - p.depth * 0.3));
            ctx.fillStyle = `rgba(${br},${bg},${bb},${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
          });
          break;
        }
        default:
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, hg);
      }
      h.raf = requestAnimationFrame(frame);
    }
    frame();
  }

  // ── alerts (popup) ───────────────────────────────────────────────────
  const alerts = {
    mount(body, win) {
      body.classList.add('wm-term', 'alerts-body');
      if (win && win.opts && win.opts.bg_color) body.style.backgroundColor = win.opts.bg_color;
      return { body, hideTimer: null };
    },
    onState(h, key, msg, overlayState, wm, winId) {
      if (key !== 'alert_event') return;
      const label = { sub: 'new subscriber', resub: 'resubscribed', bits: 'cheered bits', follow: 'new follower', raid: 'raid' }[msg.alert] || msg.alert;
      h.body.innerHTML = `<div class="line">${escapeHtml(label)}</div><div class="line" style="font-weight:700">${escapeHtml(msg.message || '')}</div>` +
        (msg.sub ? `<div class="line wm-dim">${escapeHtml(msg.sub)}</div>` : '');
      wm.showPopup(winId, true);
      if (h.hideTimer) clearTimeout(h.hideTimer);
      h.hideTimer = setTimeout(() => wm.showPopup(winId, false), 6000);
    },
    applyOpts(h, win) {
      if (win.opts && win.opts.bg_color) h.body.style.backgroundColor = win.opts.bg_color;
    },
  };

  // ── redeem_player (popup) ────────────────────────────────────────────
  const redeem_player = {
    mount(body, win) {
      if (win && win.opts && win.opts.bg_color) body.style.backgroundColor = win.opts.bg_color;
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'center';
      const video = $create('video');
      video.playsInline = true;
      const mainAudio = $create('audio');
      const scoreAudio = $create('audio');
      video.style.maxWidth = '100%';
      video.style.maxHeight = '100%';
      video.style.display = 'none';
      body.appendChild(video);
      body.appendChild(mainAudio);
      body.appendChild(scoreAudio);
      return { body, video, mainAudio, scoreAudio, queue: [], playing: false, activeCount: 0, watchdogs: [] };
    },
    onState(h, key, msg, overlayState, wm, winId) {
      if (key !== 'play_media') return;
      h.queue.push(msg);
      playNextMedia(h, wm, winId);
    },
    applyOpts(h, win) {
      if (win.opts && win.opts.bg_color) h.body.style.backgroundColor = win.opts.bg_color;
    },
  };
  function isVideoFile(name) { return /\.(mp4|webm|mov)$/i.test(name); }
  function clearWatchdogs(h) { h.watchdogs.forEach(w => clearTimeout(w)); h.watchdogs = []; }
  function armWatchdog(h, el, onDone) {
    const guessMs = (isFinite(el.duration) && el.duration > 0) ? (el.duration * 1000) + 3000 : 60000;
    h.watchdogs.push(setTimeout(onDone, guessMs));
  }
  function playEl(el, url) {
    return new Promise((resolve) => {
      el.muted = false; el.src = url; el.currentTime = 0;
      el.play().then(resolve).catch(() => {
        el.muted = true;
        el.play().then(resolve).catch(() => resolve());
      });
    });
  }
  function trackMediaEl(h, el, wm, winId) {
    h.activeCount++;
    const done = () => {
      el.removeEventListener('ended', done);
      el.removeEventListener('error', done);
      h.activeCount = Math.max(0, h.activeCount - 1);
      if (h.activeCount === 0) finishMediaItem(h, wm, winId);
    };
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    armWatchdog(h, el, done);
  }
  function playNextMedia(h, wm, winId) {
    if (h.playing || !h.queue.length) return;
    h.playing = true;
    h.activeCount = 0;
    clearWatchdogs(h);
    wm.showPopup(winId, true);
    const item = h.queue.shift();
    const mainUrl = '/media/' + encodeURIComponent(item.file);
    const mainIsVideo = isVideoFile(item.file);
    const mainEl = mainIsVideo ? h.video : h.mainAudio;
    if (mainIsVideo) { h.mainAudio.pause(); h.video.style.display = 'block'; }
    else { h.video.pause(); h.video.style.display = 'none'; }
    playEl(mainEl, mainUrl).then(() => trackMediaEl(h, mainEl, wm, winId));
    if (item.audio) {
      const scoreUrl = '/media/' + encodeURIComponent(item.audio);
      playEl(h.scoreAudio, scoreUrl).then(() => trackMediaEl(h, h.scoreAudio, wm, winId));
    }
  }
  function finishMediaItem(h, wm, winId) {
    clearWatchdogs(h);
    h.video.style.display = 'none';
    h.video.pause(); h.mainAudio.pause(); h.scoreAudio.pause();
    h.video.removeAttribute('src'); h.mainAudio.removeAttribute('src'); h.scoreAudio.removeAttribute('src');
    h.playing = false;
    wm.showPopup(winId, false);
    playNextMedia(h, wm, winId);
  }

  // ── pngtuber (topmost) ───────────────────────────────────────────────
  const pngtuber = {
    mount(body) {
      body.style.background = 'transparent';
      body.style.display = 'flex';
      body.style.alignItems = 'flex-end';
      body.style.justifyContent = 'center';
      const img = $create('img', 'pngtuber-frame');
      body.appendChild(img);
      return {
        img, assets: {}, currentState: null, currentSrc: {},
        chattingUntil: 0, ttsState: {}, statusText: '', mood: 'neutral',
      };
    },
    onState(h, key, msg) {
      if (key === 'assets') { h.assets = msg; applyPngtuberState(h); return; }
      if (key === 'tts_state') { h.ttsState = msg; applyPngtuberState(h); return; }
      if (key === 'status') { h.statusText = msg.value || ''; applyPngtuberState(h); return; }
      if (key === 'pngtuber') { h.mood = (msg && msg.mood) || 'neutral'; applyPngtuberState(h); return; }
      if (key === 'chat') { h.chattingUntil = Date.now() + 4000; applyPngtuberState(h); return; }
      if (key === 'tick') { applyPngtuberState(h); return; }
    },
  };
  function pickPngtuberImage(h, stateName) {
    const list = h.assets[stateName];
    if (!list || !list.length) return null;
    if (!h.currentSrc[stateName] || list.length === 1) {
      h.currentSrc[stateName] = list[Math.floor(Math.random() * list.length)];
    }
    return h.currentSrc[stateName];
  }
  function resolvePngtuberState(h) {
    const tts = h.ttsState || {};
    if (tts.speaking) return 'speaking';
    if (tts.generating) return 'generating';
    if (Date.now() < h.chattingUntil) return 'chatting';
    if ((h.statusText || '').toLowerCase().includes('playing:')) return 'playing';
    return h.mood || 'neutral';
  }
  function applyPngtuberState(h) {
    const next = resolvePngtuberState(h);
    if (next === h.currentState) return;
    h.currentState = next;
    if (!['neutral', 'bored', 'sad', 'cheerful'].includes(next)) delete h.currentSrc[next];
    const src = pickPngtuberImage(h, next) || pickPngtuberImage(h, 'neutral');
    if (src) {
      h.img.style.opacity = 0;
      setTimeout(() => { h.img.src = src; h.img.style.opacity = 1; }, 100);
    }
    h.img.classList.toggle('speaking', next === 'speaking');
  }

  return {
    now_playing, lyrics, status, socials, message_bar, screen, chat, extra, spacer,
    key_panel, alerts, redeem_player, pngtuber, words, tts_transcript, ad_warning, canvas,
    escapeHtml,
  };
})();