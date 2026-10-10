
const Panels = (() => {

  const $create = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // terminal-style reveal: characters appear one at a time, no fades
  function typeIn(root, cps) {
    if (!cps) return;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const full = nodes.map(n => n.nodeValue);
    const total = full.reduce((a, s) => a + s.length, 0);
    nodes.forEach(n => { n.nodeValue = ''; });
    clearInterval(root._typeTimer);
    let shown = 0;
    root._typeTimer = setInterval(() => {
      shown = Math.min(total, shown + 1);
      let left = shown;
      nodes.forEach((n, i) => { n.nodeValue = full[i].slice(0, Math.max(0, left)); left -= full[i].length; });
      if (shown >= total) clearInterval(root._typeTimer);
    }, 1000 / cps);
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
    } catch (e) {  }
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
    } catch (e) {  }
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

 
  const socials = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const lines = ((win && win.opts && win.opts.social_lines) || 'twitter: @vanillyn_net\ndiscord: @vanillyn').split(/\r?\n/).filter(Boolean);
      body.innerHTML = lines.map(l => `<span class="line">${rich(l)}</span>`).join('') + '<span class="wm-cursor">&nbsp;</span>';
      return { body };
    },
    onState() {},
    applyOpts(h, win) {
      applyTextOpts(h.body, win.opts);
      const lines = ((win.opts && win.opts.social_lines) || '').split(/\r?\n/).filter(Boolean);
      h.body.innerHTML = lines.map(l => `<span class="line">${rich(l)}</span>`).join('') + '<span class="wm-cursor">&nbsp;</span>';
    },
  };

 
  // message_bar and status_text are the same panel listening to different keys
  const textCache = {};
  function textLinePanel(key) {
    return {
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
        line.style.cssText = 'font-weight:700;white-space:normal;word-break:break-word;text-overflow:clip;overflow:visible;width:100%';
        if (textCache[key]) line.innerHTML = rich(textCache[key]);
        body.appendChild(line);
        return { body, line };
      },
      onState(h, k, msg) {
        if (k !== key) return;
        h.line.innerHTML = msg && msg.value ? rich(msg.value) : '';
      },
      applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
    };
  }
  const message_bar = textLinePanel('message');
  const status_text = textLinePanel('status');

 
  const screen = {
    mount(body) { body.style.background = 'transparent'; return {}; },
    onState() {},
  };

 
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
      return { body, wrap, win, active: [] };
    },
    // the server only says WHICH keys are down; layout/colors always come from this window's own opts
    onState(h, key, msg) {
      if (key !== 'key_panel') return;
      h.active = (msg && msg.active_keys) || [];
      renderKeyPanel(h, { ...normalizeKeyPanelConfig(h.win && h.win.opts), active_keys: h.active });
    },
    applyOpts(h, win) {
      h.win = win;
      renderKeyPanel(h, { ...normalizeKeyPanelConfig(win && win.opts), active_keys: h.active || [] });
    },
  };

  function renderKeyPanel(h, cfg) {
    const panel = normalizeKeyPanelConfig(cfg);
    h.wrap.innerHTML = '';
    const activeMap = new Set((panel.active_keys || []).map(key => normalizeKeyLabel(key)));
    const itemShape = panel.shape || 'round';
    const keyItems = panel.keys || [];
    const positioned = keyItems.some(item => Number.isFinite(Number(item.x)) || Number.isFinite(Number(item.y)));
    h.wrap.style.position = positioned ? 'relative' : '';
    h.wrap.style.display = positioned ? 'block' : 'flex';
    h.wrap.style.alignItems = positioned ? '' : 'center';
    h.wrap.style.justifyContent = positioned ? '' : 'center';
    h.wrap.style.width = '100%';
    h.wrap.style.height = '100%';
    const keySize = panel.size || 48;
    const gap = Math.max(2, panel.gap || 8);
    // later keys draw on top of earlier ones (the editor's "move up a layer" reorders this array)
    keyItems.forEach((item, index) => {
      const keyName = normalizeKeyLabel(item.key || item.label || '');
      if (!keyName) return;
      const shape = item.shape || itemShape;
      const square = $create('div', `key-panel-key key-panel-${shape}`);
      const label = $create('span');
      label.textContent = keyPanelDisplayLabel(item, keyName);
      square.appendChild(label);
      const active = activeMap.has(keyName) || !!item.active;
      const keyColor = item.color || panel.active_color || '#7ef7c6';
      const inactiveColor = item.bg_color || panel.inactive_color || '#1f2731';
      const textColor = panel.text_color || '#f5f7fa';
      const activeStops = item.color_stops || panel.active_color_stops;
      const inactiveStops = panel.inactive_color_stops;
      const borderStops = item.border_color_stops || panel.border_color_stops;
      const hasBorder = !(panel.border === false || item.border === false);
      const bw = Number(item.border_width ?? panel.border_width);
      const borderWidth = Number.isFinite(bw) ? Math.max(0, bw) : 1;
      const borderColor = item.border_color || panel.border_color || 'rgba(255,255,255,0.18)';
      let radius = item.corner_radius ?? panel.corner_radius ??
        (shape === 'square' ? '0px' : shape === 'diamond' ? '8px' : '999px');
      if (typeof radius === 'number') radius = `${radius}px`;
      const kw = Number(item.w) || keySize, kh = Number(item.h) || keySize;
      square.style.setProperty('--key-color', keyColor);
      square.style.setProperty('--key-bg', inactiveColor);
      square.style.setProperty('--key-text', textColor);
      square.style.width = `${kw}px`;
      square.style.height = `${kh}px`;
      square.style.border = hasBorder ? `${borderWidth}px solid ${borderColor}` : 'none';
      if (hasBorder) square.style.borderColor = active ? keyColor : borderColor;
      square.style.borderImage = hasBorder && borderStops && borderStops.length >= 2
        ? `linear-gradient(135deg, ${borderStops.join(', ')}) 1` : 'none';
      square.style.background = active
        ? (activeStops && activeStops.length >= 2 ? `linear-gradient(135deg, ${activeStops.join(', ')})` : keyColor)
        : (inactiveStops && inactiveStops.length >= 2 ? `linear-gradient(135deg, ${inactiveStops.join(', ')})` : inactiveColor);
      square.style.color = active ? '#08120d' : textColor;
      square.style.borderRadius = radius;
      square.style.boxShadow = 'none';
      const rot = (((Number(item.rotate) || 0) % 360) + 360) % 360;
      const tf = [shape === 'diamond' ? 'rotate(45deg)' : '', rot ? `rotate(${rot}deg)` : '',
        active ? 'translateY(1px) scale(0.97)' : ''].filter(Boolean).join(' ');
      if (tf) square.style.transform = tf;
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
    });
  }

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
        '<span style="color: yellow ;">Failed to monitor CAM1 on Channel4</span><br>Monitoring DWM1 on Channel4';
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

 
 
 
 
 
 
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

 
 
 
 
  const tts_transcript = {
    mount(body, win) {
      body.classList.add('wm-term');
      applyTextOpts(body, win && win.opts);
      const label = $create('div', 'line wm-dim');
      label.textContent = 'tts: idle';
      const info = $create('div', 'line wm-dim');
      info.textContent = 'engine: — · voice: default · queue: 0';
      const text = $create('div', 'line');
      text.style.whiteSpace = 'pre-wrap';
      body.appendChild(label);
      body.appendChild(info);
      body.appendChild(text);
      return { body, label, info, text };
    },
    onState(h, key, msg) {
      if (key !== 'tts_state') return;
      const t = msg || {};
      if (t.generating) {
        const steps = t.generation_max_steps
          ? ` · ${t.generation_step || 0}/${t.generation_max_steps} tokens · ${Number(t.generation_tokens_per_second || 0).toFixed(1)} tok/s`
          : '';
        h.label.textContent = `tts: generating ${t.engine_name || t.engine || ''} · ${Number(t.generation_elapsed || 0).toFixed(1)}s${steps}`;
      }
      else if (t.speaking) h.label.textContent = 'tts: speaking';
      else if (t.loading) h.label.textContent = `tts: loading ${t.engine_name || t.engine || 'model'}…`;
      else h.label.textContent = 'tts: idle';
      const lastGeneration = t.generation_elapsed
        ? ` · last: ${Number(t.generation_elapsed).toFixed(1)}s${t.generation_max_steps ? ` · ${t.generation_step || 0} tokens` : ''}`
        : '';
      h.info.textContent = `engine: ${t.engine_name || t.engine || '—'} · voice: ${t.voice || 'default'} · queue: ${t.queue_len || 0} · output: ${t.output_device_name || 'System default'}${lastGeneration}`;
      h.text.textContent = t.current || '';
    },
    applyOpts(h, win) { applyTextOpts(h.body, win.opts); },
  };

 
 
 
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


 
 
 
 
 
  const SCROLLER_STYLES = {
   
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
   
    flat(ctx, text, x, y, fontPx, color, t, charW) {
      ctx.font = `${fontPx}px monospace`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
    },
   
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

 
 
 
 
 
 
 
  function _deriveScrollerState(h) {
    const scene = (h.liveScene || '').toLowerCase().trim();
    const status = (h.liveStatus || '').toLowerCase().trim();

   
   
   
   
    if (scene === 'starting' || scene === 'brb' || scene === 'ending' || scene === 'playing') {
      return scene;
    }

    if (status.includes('starting')) return 'starting';
    if (status.includes('brb') || status.includes('be right back') || status.includes('technical')) return 'brb';
    if (status.includes('ending')) return 'ending';
    if (status.includes('playing:') || status.includes('playing') || status.includes('just chatting') || status.includes('live')) return 'playing';
    return 'default';
  }
  function _escapeSpacerHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

 
 
 
 
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
    waveform: '#00e0ff',
    metaballs: '#ff4fa3',
    tunnel: '#00d4ff',
    rotozoom: '#ffcf40',
    copperbars: '#ff6b6b',
    scroller: '#4ade80',
    voronoi: '#7d6bff',
    wobble: '#ff6bd6',
    htop: '#4ade80',
    floorgrid: '#39ff9e',
    bump: '#8f9dff',
    wireframe: '#5ef2ff',
    trails: '#ffd166',
    twister: '#ff61d8',
    fluid: '#5ec8ff',
    cursor: '#5ec8ff',
    'cursor-ripple': '#5ec8ff',
    'cursor-particles': '#7df9ff',
    'cursor-radar': '#5ef2ff',
    'physics-demo': '#71d6ff',
    'bouncing-ball': '#ffbb55',
    'defrag-map': '#5ef2ff',
    'chat-interactive': '#ff73c8',
    'card-cascade': '#bb9cff',
    'pointer-debug': '#5ec8ff',
  };

  function normalizeSpacerKind(win) {
    const opts = (win && win.opts) || {};
    if (opts.spacer_kind === 'typewriter') return 'bootlog';
    if (opts.spacer_kind === 'torus') {
      opts.spacer_wireframe_shape = 'torus';
      return 'wireframe';
    }
    if (opts.spacer_kind === 'lens') return 'htop';
    return opts.spacer_kind || 'bootlog';
  }

 
 
 
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
  const torusVerts = [], torusEdges = [];
  const torusRings = 18, torusSides = 10;
  for (let i = 0; i < torusRings; i++) {
    const u = (i / torusRings) * Math.PI * 2;
    for (let j = 0; j < torusSides; j++) {
      const v = (j / torusSides) * Math.PI * 2;
      const radius = 1 + 0.42 * Math.cos(v);
      torusVerts.push([radius * Math.cos(u), radius * Math.sin(u), 0.42 * Math.sin(v)]);
      const index = i * torusSides + j;
      torusEdges.push([index, i * torusSides + (j + 1) % torusSides]);
      torusEdges.push([index, ((i + 1) % torusRings) * torusSides + j]);
    }
  }
  WIREFRAME_SHAPES.torus = { verts: torusVerts, edges: torusEdges };

  function _hexToRgb(hex) {
    let h = (hex || '').replace('#', '').trim();
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return { r: 0, g: 255, b: 102 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function _pix(h) {
    const p = Number(h.win && h.win.opts && h.win.opts.spacer_pixel);
    return p >= 1 ? Math.min(12, Math.floor(p)) : 2;
  }

  function _spacerColor(h) {
    const opts = (h.win && h.win.opts) || {};
    const stops = Array.isArray(opts.spacer_color_stops) ? opts.spacer_color_stops : [];
    return (stops[0] || opts.spacer_color) || SPACER_COLOR_DEFAULTS[h.kind] || '#00ff66';
  }

  function _spacerBackground(h) {
    const opts = (h.win && h.win.opts) || {};
    return opts.spacer_bg_color || '#000000';
  }

  function _spacerGradient(ctx, h, width) {
    const stops = (h.win && h.win.opts && h.win.opts.spacer_color_stops) || [];
    if (stops.length < 2) return _spacerColor(h);
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    stops.slice(0, 5).forEach((color, index, colors) => gradient.addColorStop(index / (colors.length - 1), color));
    return gradient;
  }

  function _spacerRgbAt(h, x, width) {
    const cache = h.spacerRgbCache;
    if (cache && cache.has(x)) return cache.get(x);
    const stops = (h.win && h.win.opts && h.win.opts.spacer_color_stops) || [];
    let rgb;
    if (stops.length < 2) {
      rgb = _hexToRgb(_spacerColor(h));
    } else {
      const position = Math.max(0, Math.min(1, x / Math.max(1, width))) * (Math.min(stops.length, 5) - 1);
      const index = Math.min(Math.floor(position), Math.min(stops.length, 5) - 2);
      const amount = position - index;
      const start = _hexToRgb(stops[index]);
      const end = _hexToRgb(stops[index + 1]);
      rgb = {
        r: Math.round(start.r + (end.r - start.r) * amount),
        g: Math.round(start.g + (end.g - start.g) * amount),
        b: Math.round(start.b + (end.b - start.b) * amount),
      };
    }
    if (cache) cache.set(x, rgb);
    return rgb;
  }

  function _spacerRgb(h, x, width, factor = 1) {
    const { r, g, b } = _spacerRgbAt(h, x, width);
    const scale = value => Math.max(0, Math.min(255, Math.round(value * factor)));
    return `rgb(${scale(r)},${scale(g)},${scale(b)})`;
  }

  function _spacerRgba(h, x, width, alpha) {
    const { r, g, b } = _spacerRgbAt(h, x, width);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function _isCursorSpacer(kind) {
    return ['cursor', 'cursor-ripple', 'cursor-particles', 'cursor-radar'].includes(kind);
  }

  function _cursorSetting(h, name, fallback, min, max) {
    const value = Number(h.win && h.win.opts && h.win.opts[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function _cursorRgba(color, alpha) {
    const { r, g, b } = _hexToRgb(color);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function _cursorStyle(h) {
    const opts = (h.win && h.win.opts) || {};
    return {
      spacing: _cursorSetting(h, 'spacer_cursor_spacing', 28, 10, 80),
      dotSize: _cursorSetting(h, 'spacer_cursor_dot_size', 2, 1, 8),
      spacingOpacity: _cursorSetting(h, 'spacer_cursor_spacing_opacity', 50, 0, 100) / 100,
      markerSize: _cursorSetting(h, 'spacer_cursor_marker_size', 12, 4, 32),
      spacingColor: opts.spacer_cursor_spacing_color || '#31404a',
      accentColor: opts.spacer_cursor_accent_color || _spacerColor(h),
      radius: _cursorSetting(h, 'spacer_cursor_radius', 180, 40, 500),
      strength: _cursorSetting(h, 'spacer_cursor_strength', 70, 0, 100) / 100,
      speed: _cursorSetting(h, 'spacer_cursor_speed', 100, 0, 200) / 100,
      marker: opts.spacer_cursor_marker !== false,
    };
  }

  function _cursorGridSpacing(style, w, h) {
    const pointBudget = 7000;
    return Math.max(style.spacing, Math.sqrt((w * h) / pointBudget));
  }

  function _drawCursorMarker(ctx, cursor, style, w, h) {
    if (!style.marker || !cursor.hasPosition) return;
    const x = cursor.x * w, y = cursor.y * h;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#071014';
    ctx.beginPath(); ctx.arc(x, y, style.markerSize, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = style.accentColor;
    ctx.beginPath(); ctx.arc(x, y, style.markerSize, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(x, y, Math.max(2, style.markerSize * 0.28), 0, Math.PI * 2); ctx.fill();
  }

  function _drawCursorRipples(ctx, cursor, style, w, h, limit) {
    cursor.ripples = cursor.ripples.filter(ripple => {
      ripple.radius += 3 * Math.max(0.2, style.speed);
      ripple.life -= 0.018 * Math.max(0.2, style.speed);
      ctx.strokeStyle = _cursorRgba(style.accentColor, Math.max(0, ripple.life) * style.strength);
      ctx.lineWidth = Math.max(1, style.dotSize);
      ctx.beginPath();
      ctx.ellipse(ripple.x * w, ripple.y * h, ripple.radius, ripple.radius * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
      return ripple.life > 0 && ripple.radius < limit;
    });
  }

  function _drawCursorField(ctx, h, cursor, style, w, height) {
    const spacing = _cursorGridSpacing(style, w, height);
    const cols = Math.max(1, Math.ceil(w / spacing));
    const rows = Math.max(1, Math.ceil(height / spacing));
    const time = h.t * style.speed;
    const points = Array.from({ length: rows + 1 }, (_, row) =>
      Array.from({ length: cols + 1 }, (_, column) => {
        const bx = column / cols * w, by = row / rows * height;
        const dx = bx - cursor.x * w, dy = by - cursor.y * height;
        const distance = Math.hypot(dx, dy);
        const falloff = Math.exp(-distance / style.radius);
        const push = falloff * style.radius * 0.28 * style.strength;
        const wave = Math.sin(distance / Math.max(8, spacing * 0.75) - time * 0.12) *
          falloff * style.radius * 0.12 * style.strength;
        const amount = distance > 0 ? (push + wave) / distance : 0;
        return { x: bx + dx * amount, y: by + dy * amount };
      })
    );
    ctx.strokeStyle = _cursorRgba(style.spacingColor, 0.48 * style.spacingOpacity);
    ctx.lineWidth = Math.max(0.5, style.dotSize * 0.45);
    for (let row = 0; row <= rows; row++) {
      for (let column = 0; column <= cols; column++) {
        const point = points[row][column];
        const colorX = column / cols * w;
        ctx.fillStyle = _spacerRgb(h, colorX, w, 0.75 + 0.25 * Math.sin(time * 0.025 + row * 0.3));
        ctx.beginPath(); ctx.arc(point.x, point.y, style.dotSize, 0, Math.PI * 2); ctx.fill();
        if (column < cols) {
          const next = points[row][column + 1];
          ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(next.x, next.y); ctx.stroke();
        }
        if (row < rows) {
          const next = points[row + 1][column];
          ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(next.x, next.y); ctx.stroke();
        }
      }
    }
    _drawCursorRipples(ctx, cursor, style, w, height, style.radius * 3);
    _drawCursorMarker(ctx, cursor, style, w, height);
  }

  function _drawCursorRipple(ctx, h, cursor, style, w, height) {
    const spacing = _cursorGridSpacing(style, w, height);
    const x = cursor.x * w, y = cursor.y * height;
    const radius = Math.min(style.radius, Math.max(w, height));
    const time = h.t * style.speed;
    ctx.strokeStyle = _cursorRgba(style.spacingColor, 0.3 * style.spacingOpacity);
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= w; gx += spacing) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, height); ctx.stroke();
    }
    for (let gy = 0; gy <= height; gy += spacing) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
    for (let gy = 0; gy <= height; gy += spacing) {
      for (let gx = 0; gx <= w; gx += spacing) {
        const distance = Math.hypot(gx - x, gy - y);
        const wave = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(distance / spacing - time * 0.12));
        const strength = Math.exp(-distance / radius) * style.strength;
        ctx.fillStyle = _spacerRgba(h, gx, w, Math.min(1, 0.22 + strength * wave));
        ctx.beginPath(); ctx.arc(gx, gy, style.dotSize * (1 + strength * 1.5), 0, Math.PI * 2); ctx.fill();
      }
    }
    const ringPhase = (time * 2) % style.spacing;
    for (let ring = ringPhase; ring < radius; ring += style.spacing) {
      ctx.strokeStyle = _cursorRgba(style.accentColor, (1 - ring / radius) * style.strength * 0.6);
      ctx.lineWidth = Math.max(1, style.dotSize * 0.75);
      ctx.beginPath(); ctx.arc(x, y, ring, 0, Math.PI * 2); ctx.stroke();
    }
    _drawCursorRipples(ctx, cursor, style, w, height, radius * 2.5);
    _drawCursorMarker(ctx, cursor, style, w, height);
  }

  function _drawCursorParticles(ctx, h, cursor, style, w, height) {
    const spacing = style.spacing;
    const gridSpacing = _cursorGridSpacing(style, w, height);
    const targetCount = Math.min(900, Math.max(24, Math.floor((w * height) / (spacing * spacing * 3))));
    ctx.fillStyle = _cursorRgba(style.spacingColor, 0.24 * style.spacingOpacity);
    for (let gy = gridSpacing / 2; gy < height; gy += gridSpacing) {
      for (let gx = gridSpacing / 2; gx < w; gx += gridSpacing) {
        ctx.beginPath(); ctx.arc(gx, gy, Math.max(0.5, style.dotSize * 0.45), 0, Math.PI * 2); ctx.fill();
      }
    }
    while (cursor.particles.length < targetCount) {
      cursor.particles.push({
        x: Math.random() * w, y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.8, vy: (Math.random() - 0.5) * 0.8,
        px: null, py: null,
      });
    }
    cursor.particles.length = targetCount;
    cursor.particles.forEach(particle => {
      if (cursor.hasPosition) {
        const dx = cursor.x * w - particle.x, dy = cursor.y * height - particle.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0 && distance < style.radius) {
          const force = (1 - distance / style.radius) * style.strength * style.speed * 0.07;
          particle.vx += dx / distance * force;
          particle.vy += dy / distance * force;
        }
      }
      particle.vx = particle.vx * 0.985 + (Math.random() - 0.5) * 0.025 * style.speed;
      particle.vy = particle.vy * 0.985 + (Math.random() - 0.5) * 0.025 * style.speed;
      const maxSpeed = 1 + style.speed * 2;
      const velocity = Math.hypot(particle.vx, particle.vy);
      if (velocity > maxSpeed) {
        particle.vx = particle.vx / velocity * maxSpeed;
        particle.vy = particle.vy / velocity * maxSpeed;
      }
      particle.x = (particle.x + particle.vx + w) % w;
      particle.y = (particle.y + particle.vy + height) % height;
      if (particle.px !== null) {
        ctx.strokeStyle = _spacerRgba(h, particle.x, w, 0.2 + style.strength * 0.4);
        ctx.lineWidth = Math.max(0.5, style.dotSize * 0.55);
        ctx.beginPath(); ctx.moveTo(particle.px, particle.py); ctx.lineTo(particle.x, particle.y); ctx.stroke();
      }
      ctx.fillStyle = _spacerRgb(h, particle.x, w);
      ctx.beginPath(); ctx.arc(particle.x, particle.y, style.dotSize, 0, Math.PI * 2); ctx.fill();
      particle.px = particle.x;
      particle.py = particle.y;
    });
    if (cursor.hasPosition && style.strength > 0) {
      ctx.strokeStyle = _cursorRgba(style.accentColor, style.strength * 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cursor.x * w, cursor.y * height, style.radius, 0, Math.PI * 2); ctx.stroke();
    }
    _drawCursorMarker(ctx, cursor, style, w, height);
  }

  function _drawCursorRadar(ctx, h, cursor, style, w, height) {
    const radius = Math.min(style.radius, Math.max(w, height));
    const gridSpacing = _cursorGridSpacing(style, w, height);
    const x = cursor.x * w, y = cursor.y * height;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, height); ctx.clip();
    ctx.strokeStyle = _cursorRgba(style.spacingColor, 0.52 * style.spacingOpacity);
    ctx.lineWidth = 1;
    for (let ring = style.spacing; ring <= radius; ring += style.spacing) {
      ctx.beginPath(); ctx.arc(x, y, ring, 0, Math.PI * 2); ctx.stroke();
    }
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      ctx.stroke();
    }
    cursor.sweepAngle += 0.025 * style.speed;
    const sweepWidth = 0.65;
    ctx.fillStyle = _cursorRgba(style.accentColor, style.strength * 0.18);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, radius, cursor.sweepAngle - sweepWidth, cursor.sweepAngle);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = _cursorRgba(style.accentColor, style.strength);
    ctx.lineWidth = Math.max(1, style.dotSize);
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(cursor.sweepAngle) * radius, y + Math.sin(cursor.sweepAngle) * radius);
    ctx.stroke();
    ctx.fillStyle = _spacerGradient(ctx, h, w);
    for (let gy = gridSpacing / 2; gy < height; gy += gridSpacing) {
      for (let gx = gridSpacing / 2; gx < w; gx += gridSpacing) {
        const dx = gx - x, dy = gy - y;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const angle = Math.atan2(dy, dx);
        const delta = (cursor.sweepAngle - angle + Math.PI * 2) % (Math.PI * 2);
        if (delta < sweepWidth) {
          ctx.globalAlpha = style.strength * (1 - delta / sweepWidth);
          ctx.beginPath(); ctx.arc(gx, gy, style.dotSize * 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    _drawCursorRipples(ctx, cursor, style, w, height, radius * 2);
    _drawCursorMarker(ctx, cursor, style, w, height);
    ctx.restore();
  }

  function _drawPhysicsDemo(ctx, h, data, w, height, colorPaint) {
    ctx.fillStyle = _spacerBackground(h);
    ctx.fillRect(0, 0, w, height);
    const centerX = w * 0.5, centerY = height * 0.48;
    ctx.strokeStyle = 'rgba(120,160,180,0.12)';
    ctx.lineWidth = 1;
    for (let x = centerX % 32; x < w; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = centerY % 32; y < height; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    data.time += 0.012;
    data.bodies.forEach((body, index) => {
      body.vy += 0.025;
      body.x += body.vx;
      body.y += body.vy;
      if (body.x < body.radius || body.x > w - body.radius) body.vx *= -0.96;
      if (body.y < body.radius || body.y > height - body.radius) body.vy *= -0.9;
      body.x = Math.max(body.radius, Math.min(w - body.radius, body.x));
      body.y = Math.max(body.radius, Math.min(height - body.radius, body.y));
      body.trail.push({ x: body.x, y: body.y });
      if (body.trail.length > 36) body.trail.shift();
      ctx.strokeStyle = _spacerRgba(h, index * w / data.bodies.length, w, 0.25);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      body.trail.forEach((point, trailIndex) => {
        if (!trailIndex) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      const forceX = body.vx * 14, forceY = body.vy * 14;
      ctx.strokeStyle = _spacerRgba(h, index * w / data.bodies.length, w, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(body.x, body.y); ctx.lineTo(body.x + forceX, body.y + forceY); ctx.stroke();
      ctx.fillStyle = colorPaint;
      ctx.beginPath(); ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = 'rgba(220,235,245,0.72)';
    ctx.font = '11px monospace';
    ctx.fillText('GRAVITY  ↓   ·   VELOCITY  →   ·   WALL COLLISIONS', 10, height - 10, Math.max(0, w - 20));
  }

  function _drawBouncingBall(ctx, data, w, height, colorPaint) {
    const floor = height - data.radius - 1;
    data.vy += 0.34;
    data.x += data.vx;
    data.y += data.vy;
    if (data.x < data.radius) { data.x = data.radius; data.vx = Math.abs(data.vx); }
    if (data.x > w - data.radius) { data.x = w - data.radius; data.vx = -Math.abs(data.vx); }
    if (data.y >= floor) {
      data.y = floor;
      if (Math.abs(data.vy) > 1.1) data.vy = -Math.abs(data.vy) * 0.82;
      else { data.vy = 0; data.vx *= 0.995; }
    }
    data.trail.push({ x: data.x, y: data.y });
    if (data.trail.length > 24) data.trail.shift();
    ctx.strokeStyle = 'rgba(255,255,255,0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    data.trail.forEach((point, i) => {
      if (!i) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.fillStyle = colorPaint;
    ctx.beginPath(); ctx.arc(data.x, data.y, data.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(220,235,245,0.6)';
    ctx.fillRect(0, height - 2, w, 2);
  }

  function _drawDefragMap(ctx, h, data, w, height, colorPaint) {
      const { cols, rows } = data;
    data.tick++;
    if (data.tick % 3 === 0) {
      for (let step = 0; step < 2; step++) {
          if (data.cursor >= data.blocks.length) {
          data.cursor = 0;
          data.cycles++;
            data.blocks = data.blocks.map((_, index) => index < data.blocks.length * (0.45 + Math.random() * 0.3) ? 1 : 0);
          } else if (!data.blocks[data.cursor]) {
            const next = data.blocks.indexOf(1, data.cursor + 1);
          if (next !== -1) {
              data.blocks[data.cursor] = 1;
              data.blocks[next] = 0;
          }
        }
        data.cursor++;
      }
    }
    ctx.fillStyle = _spacerBackground(h);
    ctx.fillRect(0, 0, w, height);
    const gap = 2;
    const cellW = Math.max(1, (w - gap * (cols + 1)) / cols);
    const cellH = Math.max(1, (height - 38 - gap * (rows + 1)) / rows);
    let used = 0;
    data.blocks.forEach((occupied, index) => {
      if (occupied) used++;
      const x = gap + (index % cols) * (cellW + gap);
      const y = 26 + gap + Math.floor(index / cols) * (cellH + gap);
      const scanning = index === data.cursor;
      ctx.fillStyle = scanning ? '#ffffff' : occupied ? _spacerRgb(h, x, w, 0.9) : 'rgba(130,150,160,0.12)';
      ctx.fillRect(x, y, cellW, cellH);
    });
    ctx.fillStyle = colorPaint;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(`DISK MAP  ·  COMPACTING  ·  ${Math.round(100 * used / data.blocks.length)}% USED`, 8, 17, Math.max(0, w - 16));
  }

  function _drawChatInteractive(ctx, h, data, w, height, colorPaint) {
    ctx.fillStyle = _spacerBackground(h);
    ctx.fillRect(0, 0, w, height);
    data.time += 0.02;
    data.messages.forEach(message => {
      message.age++;
      message.x += message.vx;
      message.y += message.vy;
      message.vx *= 0.992;
      message.vy *= 0.992;
      if (message.age > 500) message.alpha = Math.max(0, 1 - (message.age - 500) / 120);
      ctx.globalAlpha = message.alpha;
      ctx.strokeStyle = _spacerRgba(h, message.x, w, 0.38);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(message.x, message.y, message.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = _spacerRgba(h, message.x, w, 0.09);
      ctx.beginPath(); ctx.arc(message.x, message.y, message.radius, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colorPaint;
      ctx.font = 'bold 11px monospace';
      ctx.fillText(message.user, message.x + 8, message.y - 5, Math.max(0, message.radius * 1.5));
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(240,245,250,0.9)';
      ctx.fillText(message.text, message.x + 8, message.y + 10, Math.max(0, message.radius * 1.5));
      message.particles.forEach(particle => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.life -= 0.012;
        ctx.globalAlpha = Math.max(0, particle.life) * message.alpha;
        ctx.fillStyle = _spacerRgb(h, particle.x, w);
        ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2); ctx.fill();
      });
    });
    ctx.globalAlpha = 1;
    data.messages = data.messages.filter(message => message.alpha > 0 && message.y > -60 && message.y < height + 60);
    ctx.fillStyle = 'rgba(220,235,245,0.56)';
    ctx.font = '10px monospace';
    ctx.fillText(data.messages.length ? `CHAT ENERGY  ·  ${data.messages.length} ACTIVE` : 'WAITING FOR CHAT…', 10, height - 10);
  }

  function _addChatInteractiveMessage(data, msg, w, height) {
    if (!msg || (!msg.text && !msg.user)) return;
    const x = Math.random() * Math.max(1, w);
    const y = height + 24;
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const particles = Array.from({ length: Math.min(18, 5 + Math.ceil(text.length / 8)) }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 2.4;
      return {
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1,
        life: 0.8 + Math.random() * 0.2, size: 1 + Math.random() * 2.5,
      };
    });
    data.messages.push({
      user: String(msg.user || 'viewer').slice(0, 24),
      text: text || '…',
      x, y, vx: (Math.random() - 0.5) * 0.7, vy: -0.8 - Math.random() * 1.2,
      radius: 32 + Math.min(40, text.length * 0.3), age: 0, alpha: 1, particles,
    });
    if (data.messages.length > 36) data.messages.shift();
  }

  function _drawCardCascade(ctx, h, data, w, height, colorPaint) {
    ctx.fillStyle = _spacerBackground(h);
    ctx.fillRect(0, 0, w, height);
    data.time += 0.012;
    const cardW = Math.min(w * 0.48, 230), cardH = Math.min(height * 0.5, 135);
    data.cards.forEach((card, index) => {
      const angle = data.time * (card.speed * 0.12) + card.phase;
      const depth = (index + 1) / data.cards.length;
      const orbitX = Math.sin(angle) * w * 0.24;
      const orbitY = Math.cos(angle * 0.7 + card.phase) * height * 0.22;
      const scale = 0.48 + depth * 0.55;
      const x = w * 0.5 + orbitX - cardW * scale * 0.5;
      const y = height * 0.52 + orbitY - cardH * scale * 0.5;
      ctx.save();
      ctx.globalAlpha = 0.28 + depth * 0.7;
      ctx.translate(x + cardW * scale / 2, y + cardH * scale / 2);
      ctx.rotate(Math.sin(angle * 0.6) * 0.11);
      ctx.scale(scale, scale);
      ctx.fillStyle = 'rgba(13,20,28,0.94)';
      ctx.strokeStyle = _spacerRgba(h, index * w / data.cards.length, w, 0.3 + depth * 0.65);
      ctx.lineWidth = 1.5;
      ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
      ctx.strokeRect(-cardW / 2, -cardH / 2, cardW, cardH);
      ctx.fillStyle = colorPaint;
      ctx.fillRect(-cardW / 2, -cardH / 2, cardW, 20);
      ctx.fillStyle = '#10161c';
      ctx.beginPath();
      ctx.arc(-cardW / 2 + 9, -cardH / 2 + 10, 2.5, 0, Math.PI * 2);
      ctx.arc(-cardW / 2 + 18, -cardH / 2 + 10, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(215,230,240,0.7)';
      ctx.fillRect(-cardW / 2 + 12, -cardH / 2 + 38, cardW * 0.62, 5);
      ctx.fillRect(-cardW / 2 + 12, -cardH / 2 + 52, cardW * 0.4, 4);
      ctx.fillRect(-cardW / 2 + 12, -cardH / 2 + 66, cardW * 0.74, 4);
      ctx.restore();
    });
  }

  function _applySpacerTextGradient(h) {
    const stops = (h.win && h.win.opts && h.win.opts.spacer_color_stops) || [];
    h.pre.querySelectorAll('.line').forEach(line => {
      line.style.backgroundImage = stops.length >= 2 ? `linear-gradient(90deg, ${stops.join(', ')})` : '';
      line.style.backgroundClip = stops.length >= 2 ? 'text' : '';
      line.style.webkitBackgroundClip = stops.length >= 2 ? 'text' : '';
      line.style.webkitTextFillColor = stops.length >= 2 ? 'transparent' : '';
    });
  }

  const spacer = {
    mount(body, win) {
      body.classList.add('wm-term', 'spacer-body');
      const kind = normalizeSpacerKind(win);
      const canvasEl = document.createElement('canvas');
      const pre = document.createElement('div');
      pre.className = 'spacer-pre';
      body.appendChild(canvasEl);
      body.appendChild(pre);

     
     
     
     
     
     
     
      const h = { kind, win, canvas: canvasEl, pre, raf: null, timer: null, lineIdx: 0, cleanups: [], body, modeData: {}, t: 0, liveStatus: '', liveScene: '' };
      startSpacer(h);
      return h;
    },
    onState(h, key, msg) {
      if (key === 'chat' && h.kind === 'chat-interactive') {
        _addChatInteractiveMessage(
          h.modeData.chatInteractive, msg,
          h.canvas.width * _pix(h), h.canvas.height * _pix(h)
        );
        return;
      }
      if (key === 'pointer' && msg) {
        if (_isCursorSpacer(h.kind)) {
          const cursor = h.modeData.cursor;
          const x = Number(msg.x), y = Number(msg.y);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const nextX = Math.max(0, Math.min(1, x));
            const nextY = Math.max(0, Math.min(1, y));
            const distance = Math.hypot(nextX - cursor.x, nextY - cursor.y);
            cursor.x = nextX;
            cursor.y = nextY;
            cursor.hasPosition = true;
            cursor.buttons = Number(msg.buttons) || 0;
            const now = performance.now();
            if (h.kind === 'cursor-ripple' && distance > 0.004 && now - cursor.lastRippleAt > 75) {
              cursor.ripples.push({ x: nextX, y: nextY, radius: 0, life: 1 });
              cursor.lastRippleAt = now;
            }
          }
          if (msg.action === 'down' && cursor.hasPosition) {
            cursor.ripples.push({ x: cursor.x, y: cursor.y, radius: 0, life: 1 });
            if (cursor.ripples.length > 24) cursor.ripples.shift();
          }
        } else if (h.kind === 'pointer-debug') {
          const debug = h.modeData.pointerDebug;
          debug.messageCount += 1;
          debug.last = msg;
          debug.lastAt = performance.now();
        }
        return;
      }
      if (key === 'status') {
        h.liveStatus = (msg && msg.value) || '';
        return;
      }
      if (key === 'scene') {
        h.liveScene = (msg && msg.value) || '';
        return;
      }
      if (msg && msg.spacer_kind) {
        h.win = { ...h.win, opts: { ...(h.win && h.win.opts || {}), spacer_kind: msg.spacer_kind } };
        const kind = normalizeSpacerKind(h.win);
        if (kind !== h.kind) {
          h.kind = kind;
          this.unmount(h);
          startSpacer(h);
        }
      }
    },
    applyOpts(h, win) {
      h.win = win;
      h.body.style.backgroundColor = _spacerBackground(h);
      if (h.resize) h.resize();
      const kind = normalizeSpacerKind(win);
      if (kind !== h.kind) {
        h.kind = kind;
        spacer.unmount(h);
        startSpacer(h);
      }
     
     
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

    if (h.kind === 'bootlog') {
      h.pre.style.display = 'block';
      h.canvas.style.display = 'none';
      h.pre.style.color = _spacerColor(h);
      h.body.style.backgroundColor = _spacerBackground(h);
      const lines = BOOTLOG_LINES;
      const tick = () => {
        h.pre.style.color = _spacerColor(h);
        const n = Math.min(lines.length, h.lineIdx + 1);
        h.pre.innerHTML =
          lines.slice(0, n)
            .map(l => `<div class="line">${_escapeSpacerHtml(l)}</div>`)
            .join('') + '<span class="wm-cursor" style="background:' + _spacerColor(h) + ';">&nbsp;</span>';
        _applySpacerTextGradient(h);
        h.lineIdx = (h.lineIdx + 1) % (lines.length + 3);
        h.timer = setTimeout(tick, 600);
      };
      tick();
      return;
    }

    h.pre.style.display = 'none';
    h.canvas.style.display = 'block';
    h.canvas.style.imageRendering = 'pixelated';
    h.body.style.backgroundColor = _spacerBackground(h);
    const ctx = h.canvas.getContext('2d');

    function resize() {
      const P = _pix(h);
      h.canvas.width = Math.max(1, Math.floor((h.body.clientWidth || 300) / P));
      h.canvas.height = Math.max(1, Math.floor((h.body.clientHeight || 200) / P));
    }
    h.resize = resize;
    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(h.body);
    h.cleanups.push(() => ro.disconnect());

    const modeData = h.modeData;

    if (h.kind === 'matrix') {
      const chars = '01アイウエオカキクケコサシスセソ$#@%&*';
      let cols = new Array(Math.floor((h.canvas.width * _pix(h)) / 14)).fill(0);
      modeData.matrix = { chars, cols };
    } else if (h.kind === 'starfield') {
      const stars = Array.from({ length: 220 }, () => ({
        x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() * 1000, px: null, py: null
      }));
      modeData.stars = stars;
    } else if (h.kind === 'fire') {
      modeData.fireCols = Math.floor((h.canvas.width * _pix(h)) / 4);
      modeData.fireRows = Math.floor((h.canvas.height * _pix(h)) / 4);
      modeData.fireBuf = new Array(modeData.fireCols * modeData.fireRows).fill(0);
    } else if (h.kind === 'rain') {
      const cols = Math.max(1, Math.floor((h.canvas.width * _pix(h)) / 6));
      modeData.rain = Array.from({ length: cols }, () => ({
        y: Math.random() * -500,
        speed: 4 + Math.random() * 8,
        len: 10 + Math.random() * 20,
      }));
    } else if (h.kind === 'dna') {
      modeData.dna = { angle: 0 };
    } else if (h.kind === 'pipes') {
      modeData.pipes = { walkers: [], cell: 12, grid: false, cols: 0, rows: 0 };
    } else if (h.kind === 'life') {
      const cell = 6;
      const cols = Math.max(4, Math.floor((h.canvas.width * _pix(h)) / cell));
      const rows = Math.max(4, Math.floor((h.canvas.height * _pix(h)) / cell));
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
    } else if (h.kind === 'htop') {
      modeData.htop = { v: [] };
    } else if (h.kind === 'floorgrid') {
      modeData.floorgrid = {};
    } else if (h.kind === 'bump') {
      modeData.bump = { lightAngle: 0 };
    } else if (h.kind === 'wireframe') {
      modeData.wireframe = { ax: 0, ay: 0, az: 0 };
    } else if (h.kind === 'trails') {
      modeData.trails = { particles: [], tick: 0 };
    } else if (h.kind === 'twister') {
      modeData.twister = { angle: 0 };
    } else if (h.kind === 'fluid') {
      modeData.fluid = { time: 0 };
    } else if (_isCursorSpacer(h.kind)) {
      const pointer = pointerCache;
      modeData.cursor = {
        x: pointer.x, y: pointer.y,
        hasPosition: pointer.action !== 'leave' && pointer.action !== 'cancel',
        buttons: pointer.buttons || 0, ripples: [], lastRippleAt: 0,
        particles: [], sweepAngle: 0,
      };
    } else if (h.kind === 'physics-demo') {
      const width = h.canvas.width * _pix(h), height = h.canvas.height * _pix(h);
      modeData.physicsDemo = {
        time: 0,
        bodies: Array.from({ length: 7 }, (_, index) => ({
          x: width * (0.18 + Math.random() * 0.64),
          y: height * (0.12 + Math.random() * 0.5),
          vx: (Math.random() - 0.5) * 3.2,
          vy: Math.random() * 1.5,
          radius: 4 + Math.random() * 4,
          trail: [],
          index,
        })),
      };
    } else if (h.kind === 'bouncing-ball') {
      const width = h.canvas.width * _pix(h), height = h.canvas.height * _pix(h);
      modeData.bouncingBall = {
        x: width * 0.28, y: height * 0.2, vx: 3.1, vy: 0,
        radius: Math.max(8, Math.min(width, height) * 0.065), trail: [],
      };
    } else if (h.kind === 'defrag-map') {
      const cols = Math.max(12, Math.min(72, Math.floor((h.canvas.width * _pix(h)) / 12)));
      const rows = Math.max(8, Math.min(42, Math.floor((h.canvas.height * _pix(h)) / 12)));
      const length = cols * rows;
      modeData.defragMap = {
        cols, rows, cursor: 0, tick: 0, cycles: 0,
        blocks: Array.from({ length }, (_, index) => index < length * 0.68 && Math.random() > 0.24 ? 1 : 0),
      };
    } else if (h.kind === 'chat-interactive') {
      modeData.chatInteractive = { time: 0, messages: [] };
      const width = h.canvas.width * _pix(h), height = h.canvas.height * _pix(h);
      chatCache.forEach(message => _addChatInteractiveMessage(modeData.chatInteractive, message, width, height));
    } else if (h.kind === 'card-cascade') {
      modeData.cardCascade = {
        time: 0,
        cards: Array.from({ length: 8 }, (_, index) => ({
          phase: index * Math.PI * 0.37, speed: 0.5 + Math.random() * 1.5,
        })),
      };
    } else if (h.kind === 'pointer-debug') {
      modeData.pointerDebug = { messageCount: 0, last: null, lastAt: null };
    }

    function frame() {
      h.t += 1;
      const P = _pix(h);
      ctx.setTransform(1 / P, 0, 0, 1 / P, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const w = h.canvas.width * P;
      const hg = h.canvas.height * P;
      h.spacerRgbCache = new Map();
      const colorPaint = _spacerGradient(ctx, h, w);

      switch (h.kind) {
        case 'matrix': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.15;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          ctx.fillStyle = colorPaint;
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
          const img = ctx.createImageData(h.canvas.width, h.canvas.height);
          for (let i = 0; i < img.data.length; i += 4) {
            const v = Math.random();
            const { r, g, b } = _spacerRgbAt(h, ((i / 4) % h.canvas.width) * P, w);
            img.data[i] = r * v;
            img.data[i + 1] = g * v;
            img.data[i + 2] = b * v;
            img.data[i + 3] = 255;
          }
          ctx.putImageData(img, 0, 0);
          break;
        }
        case 'starfield': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2, cy = hg / 2;
          modeData.stars.forEach(s => {
            s.z -= 6;
            if (s.z <= 0) {
              s.z = 1000;
              s.x = (Math.random() - 0.5) * 2;
              s.y = (Math.random() - 0.5) * 2;
              s.px = null;
              s.py = null;
            }
            const scale = Math.min(w, hg) * 0.72;
            const px = (s.x * scale * 1000) / s.z + cx;
            const py = (s.y * scale * 1000) / s.z + cy;
            if (px >= 0 && px < w && py >= 0 && py < hg) {
              const progress = 1 - s.z / 1000;
              const size = 0.8 + progress * 3.8;
              const shade = 0.45 + progress * 0.55;
              const { r, g, b } = _spacerRgbAt(h, px, w);
              ctx.fillStyle = `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`;
              if (s.px !== null && s.py !== null) {
                ctx.globalAlpha = 0.25 + progress * 0.75;
                ctx.strokeStyle = colorPaint;
                ctx.lineWidth = Math.max(1, size * 0.55);
                ctx.beginPath();
                ctx.moveTo(s.px, s.py);
                ctx.lineTo(px, py);
                ctx.stroke();
              }
              ctx.globalAlpha = 1;
              ctx.beginPath();
              ctx.arc(px, py, size / 2, 0, Math.PI * 2);
              ctx.fill();
            }
            s.px = px;
            s.py = py;
          });
          break;
        }
        case 'oscilloscope': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.2;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = colorPaint;
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
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const val = buf[r * cols + c];
              if (val > 0) {
                const t2 = val / 255;
                const { r: br, g: bg, b: bb } = _spacerRgbAt(h, c * pw, w);
                ctx.fillStyle = `rgb(${Math.min(255, Math.round(br * t2 + 255 * (1 - t2) * (t2)))},${Math.round(bg * t2)},${Math.round(bb * t2 * 0.5)})`;
                ctx.fillRect(c * pw, r * ph, pw, ph);
              }
            }
          }
          modeData.fireBuf = buf;
          break;
        }
        case 'plasma': {
         
          const block = 6;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const time = h.t * 0.04;
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const v = Math.sin(xx * 0.15 + time) + Math.sin(yy * 0.15 + time * 1.3) +
                        Math.sin((xx + yy) * 0.1 + time * 0.7) + Math.sin(Math.sqrt(xx * xx + yy * yy) * 0.12 - time);
              const t2 = (v + 4) / 8;
              const { r: br, g: bg, b: bb } = _spacerRgbAt(h, xx * block, w);
              ctx.fillStyle = `rgb(${Math.round(br * t2)},${Math.round(bg * (1 - t2) + bg * t2 * 0.3)},${Math.round(bb * (1 - t2 * 0.5))})`;
              ctx.fillRect(xx * block, yy * block, block, block);
            }
          }
          break;
        }
        case 'rain': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.25;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = colorPaint;
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
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.3;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          const cx = w / 2;
          const amp = Math.min(w * 0.28, 80);
          const steps = 40;
          modeData.dna.angle += 0.05;
          for (let i = 0; i < steps; i++) {
            const y = (i / steps) * hg;
            const phase = modeData.dna.angle + i * 0.35;
            const x1 = cx + Math.sin(phase) * amp;
            const x2 = cx + Math.sin(phase + Math.PI) * amp;
            const depth1 = (Math.cos(phase) + 1) / 2;
            const depth2 = (Math.cos(phase + Math.PI) + 1) / 2;
            if (i % 3 === 0) {
              ctx.strokeStyle = _spacerRgba(h, (x1 + x2) / 2, w, 0.25 + 0.25 * Math.min(depth1, depth2));
              ctx.lineWidth = 1.5;
              ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
            }
            ctx.fillStyle = _spacerRgba(h, x1, w, 0.4 + 0.6 * depth1);
            ctx.beginPath(); ctx.arc(x1, y, 3 + depth1 * 2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = _spacerRgba(h, x2, w, 0.4 + 0.6 * depth2);
            ctx.beginPath(); ctx.arc(x2, y, 3 + depth2 * 2, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'pipes': {
          const pipes = modeData.pipes;
          const cell = pipes.cell;
          const cols = Math.max(2, Math.floor(w / cell));
          const rows = Math.max(2, Math.floor(hg / cell));
          if (!pipes.grid || pipes.cols !== cols || pipes.rows !== rows) {
            pipes.cols = cols;
            pipes.rows = rows;
            pipes.grid = true;
            pipes.walkers = [{
              x: Math.floor(cols / 2), y: Math.floor(rows / 2),
              dir: Math.floor(Math.random() * 4), life: 1200, hue: Math.random(),
            }];
            ctx.fillStyle = _spacerBackground(h);
            ctx.fillRect(0, 0, w, hg);
          }
          if (pipes.walkers.length < 4 && Math.random() > 0.985) {
            pipes.walkers.push({
              x: Math.floor(Math.random() * pipes.cols),
              y: Math.floor(Math.random() * pipes.rows),
              dir: Math.floor(Math.random() * 4),
              life: 700 + Math.random() * 500,
              hue: Math.random(),
            });
          }
          pipes.walkers = pipes.walkers.filter(walker => {
            walker.life -= 1;
            if (walker.life <= 0) return false;
            const previousX = walker.x, previousY = walker.y;
            if (Math.random() > 0.88) {
              const turn = Math.random() > 0.5 ? 1 : 3;
              walker.dir = (walker.dir + turn) % 4;
            }
            const dx = [1, 0, -1, 0][walker.dir], dy = [0, 1, 0, -1][walker.dir];
            let nextX = walker.x + dx, nextY = walker.y + dy;
            if (nextX < 0 || nextX >= pipes.cols || nextY < 0 || nextY >= pipes.rows) {
              walker.dir = (walker.dir + (Math.random() > 0.5 ? 1 : 3)) % 4;
              nextX = walker.x + [1, 0, -1, 0][walker.dir];
              nextY = walker.y + [0, 1, 0, -1][walker.dir];
            }
            walker.x = nextX;
            walker.y = nextY;
            ctx.strokeStyle = _spacerRgb(h, walker.x * cell, w, 0.65 + walker.hue * 0.7);
            ctx.lineWidth = cell * 0.62;
            ctx.lineCap = 'square';
            ctx.beginPath();
            ctx.moveTo(previousX * cell + cell / 2, previousY * cell + cell / 2);
            ctx.lineTo(walker.x * cell + cell / 2, walker.y * cell + cell / 2);
            ctx.stroke();
            return true;
          });
          if (!pipes.walkers.length) pipes.grid = false;
          break;
        }
        case 'life': {
          const L = modeData.life;
          ctx.fillStyle = _spacerBackground(h);
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
           
            let count = 0; for (let i = 0; i < next.length; i++) count += next[i];
            if (count < L.cells.length * 0.02) {
              for (let i = 0; i < next.length; i++) next[i] = Math.random() > 0.75 ? 1 : 0;
            }
            L.cells = next;
          }
          ctx.fillStyle = colorPaint;
          for (let y = 0; y < L.rows; y++) {
            for (let x = 0; x < L.cols; x++) {
              if (L.cells[y * L.cols + x]) ctx.fillRect(x * L.cell, y * L.cell, L.cell - 1, L.cell - 1);
            }
          }
          break;
        }
        case 'waveform': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.35;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          const WF = modeData.waveform;
          const barW = w / WF.bars;
          for (let i = 0; i < WF.bars; i++) {
            WF.phases[i] += 0.05 + (i % 5) * 0.01;
            const amp = (Math.sin(WF.phases[i]) * 0.5 + 0.5) * (0.4 + 0.6 * Math.sin(h.t * 0.02 + i * 0.3) ** 2);
            const barH = amp * hg * 0.85;
            const alpha = 0.5 + amp * 0.5;
            ctx.fillStyle = _spacerRgba(h, i * barW, w, alpha);
            ctx.fillRect(i * barW + 1, hg - barH, barW - 2, barH);
          }
          break;
        }
        case 'metaballs': {
         
         
          const block = 5;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const balls = modeData.metaballs.balls;
          balls.forEach(b => {
            b.x += b.vx; b.y += b.vy;
            if (b.x < 0 || b.x > 1) b.vx *= -1;
            if (b.y < 0 || b.y > 1) b.vy *= -1;
          });
          ctx.fillStyle = _spacerBackground(h);
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
                ctx.fillStyle = _spacerRgba(h, xx * block, w, 0.35 + t2 * 0.65);
                ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
              }
            }
          }
          break;
        }
        case 'tunnel': {
         
          const block = 4;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          const cx = w / 2, cy = hg / 2;
          modeData.tunnel.angle += 0.02;
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const dx = xx * block - cx, dy = yy * block - cy;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
              const ang = Math.atan2(dy, dx);
              const depth = (1 / dist) * 260 + h.t * 0.06;
              const ring = (Math.sin(depth) + Math.sin(ang * 6 + modeData.tunnel.angle)) * 0.5;
              const t2 = (ring + 1) / 2;
              const { r: br, g: bg, b: bb } = _spacerRgbAt(h, xx * block, w);
              ctx.fillStyle = `rgb(${Math.round(br * t2)},${Math.round(bg * t2)},${Math.round(bb * t2)})`;
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'rotozoom': {
         
         
         
         
         
          const block = 4;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          modeData.rotozoom.angle += 0.012;
          const zoom = 1.1 + Math.sin(h.t * 0.015) * 0.35;
          const ca = Math.cos(modeData.rotozoom.angle) * zoom;
          const sa = Math.sin(modeData.rotozoom.angle) * zoom;
          const cx = w / 2, cy = hg / 2;
          const checkSize = Math.max(24, Math.min(w, hg) / 8);
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const px = xx * block - cx, py = yy * block - cy;
              const u = px * ca - py * sa;
              const v = px * sa + py * ca;
              const check = (Math.floor(u / checkSize) + Math.floor(v / checkSize)) % 2 === 0;
              const { r: br, g: bg, b: bb } = _spacerRgbAt(h, xx * block, w);
              const darkR = Math.round(br * 0.15), darkG = Math.round(bg * 0.15), darkB = Math.round(bb * 0.15);
              ctx.fillStyle = check ? `rgb(${br},${bg},${bb})` : `rgb(${darkR},${darkG},${darkB})`;
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'copperbars': {
         
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const barCount = modeData.copperbars.bars;
          const barH = Math.max(18, hg / 14);
          const strips = Math.min(48, Math.max(1, Math.ceil(w / 24)));
          const stripW = w / strips;
          for (let i = 0; i < barCount; i++) {
            const phase = h.t * 0.04 + i * 0.6;
            const cy = hg / 2 + Math.sin(phase) * (hg / 2 - barH);
            for (let strip = 0; strip < strips; strip++) {
              const { r, g, b } = _spacerRgbAt(h, (strip + 0.5) * stripW, w);
              const grad = ctx.createLinearGradient(0, cy - barH / 2, 0, cy + barH / 2);
              grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
              grad.addColorStop(0.5, `rgba(${r},${g},${b},0.9)`);
              grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(strip * stripW, cy - barH / 2, stripW + 1, barH);
            }
          }
          break;
        }
        case 'scroller': {
         
         
         
         
         
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.3;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
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
         
         
         
          const bannerCell = Math.max(3, Math.floor(fontPx / 6));
          const charW = styleName === 'banner' ? (6 * bannerCell) : (ctx.measureText('M').width || 14);
          const cy = hg / 2;
          styleFn(ctx, S.text, S.x, cy, fontPx, colorPaint, h.t, charW);
          S.x -= 3;
          const totalW = S.text.length * charW;
          if (S.x < -totalW) {
            S.text = _pickScrollerMessage(h);
            S.x = w;
          }
          break;
        }
        case 'voronoi': {
         
         
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
              ctx.fillStyle = _spacerRgb(h, xx * block, w, 0.4 + t2 * 1.1);
              ctx.fillRect(xx * block, yy * block, block + 1, block + 1);
            }
          }
          break;
        }
        case 'wobble': {
         
         
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const cx = w / 2, cy = hg / 2;
          const maxR = Math.sqrt(cx * cx + cy * cy);
          const rings = modeData.wobble.rings;
          ctx.lineWidth = 3;
          for (let i = 0; i < rings * 4; i++) {
            const baseR = (i / (rings * 4)) * maxR;
            const wob = Math.sin(baseR * 0.05 - h.t * 0.06) * 14;
            ctx.strokeStyle = colorPaint;
            ctx.globalAlpha = 0.15 + 0.5 * ((i % 4) / 4);
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(0, baseR + wob), 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'htop': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const H = modeData.htop;
          const fontPx = 12, rowH = fontPx + 4;
          ctx.font = fontPx + 'px monospace';
          ctx.textBaseline = 'middle';
          const cw = ctx.measureText('M').width || 7;
          const rows = Math.max(1, Math.floor((hg - 4) / rowH));
          while (H.v.length < rows) H.v.push(Math.random());
          H.v.length = rows;
          const barCols = Math.max(4, Math.floor((w - 8) / cw) - 11);
          ctx.fillStyle = colorPaint;
          for (let i = 0; i < rows; i++) {
            if (h.t % 8 === 0) H.v[i] = Math.min(1, Math.max(0, H.v[i] + (Math.random() - 0.5) * 0.25));
            const filled = Math.round(H.v[i] * barCols);
            const pct = String(Math.round(H.v[i] * 100)).padStart(3, ' ');
            const line = String(i + 1).padStart(2, ' ') + ' [' + '|'.repeat(filled) + ' '.repeat(barCols - filled) + '] ' + pct + '%';
            ctx.fillText(line, 4, 4 + rowH * i + rowH / 2);
          }
          break;
        }
        case 'floorgrid': {
         
         
         
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const horizon = hg * 0.42;
          ctx.strokeStyle = colorPaint;
          ctx.lineWidth = 1;
          ctx.globalAlpha = 0.7;
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
            ctx.globalAlpha = 0.7 * Math.min(1, t2 + 0.15);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'bump': {
         
         
          const block = 6;
          const cols = Math.ceil(w / block), rows = Math.ceil(hg / block);
          modeData.bump.lightAngle += 0.02;
          const lx = w / 2 + Math.cos(modeData.bump.lightAngle) * w * 0.35;
          const ly = hg / 2 + Math.sin(modeData.bump.lightAngle) * hg * 0.35;
          for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < cols; xx++) {
              const px = xx * block, py = yy * block;
              const height = Math.sin(px * 0.05 + h.t * 0.04) * Math.cos(py * 0.05 + h.t * 0.03);
              const dx = (lx - px) / w, dy = (ly - py) / hg;
              const lightDot = Math.max(0, dx * Math.cos(height) + dy * Math.sin(height));
              const shade = 0.15 + lightDot * 0.85;
              ctx.fillStyle = _spacerRgb(h, px, w, shade);
              ctx.fillRect(px, py, block + 1, block + 1);
            }
          }
          break;
        }
        case 'wireframe': {
         
         
         
          ctx.fillStyle = _spacerBackground(h);
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
          const dist = 4;
          const projected = shape.verts.map(([vx, vy, vz]) => {
           
            let y1 = vy * cosx - vz * sinx, z1 = vy * sinx + vz * cosx;
           
            let x2 = vx * cosy + z1 * siny, z2 = -vx * siny + z1 * cosy;
           
            let x3 = x2 * cosz - y1 * sinz, y3 = x2 * sinz + y1 * cosz;
            const persp = dist / (dist + z2);
            return { x: cx + x3 * scale * persp, y: cy + y3 * scale * persp, depth: z2 };
          });
          shape.edges.forEach(([a, b2]) => {
            const p1 = projected[a], p2 = projected[b2];
            const avgDepth = (p1.depth + p2.depth) / 2;
            ctx.globalAlpha = Math.max(0.25, Math.min(1, 1 - avgDepth * 0.3));
            ctx.strokeStyle = colorPaint;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          });
         
          projected.forEach(p => {
            ctx.globalAlpha = Math.max(0.4, Math.min(1, 1 - p.depth * 0.3));
            ctx.fillStyle = colorPaint;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.globalAlpha = 1;
          break;
        }
        case 'trails': {
          const T = modeData.trails;
          ctx.fillStyle = _spacerBackground(h);
          ctx.globalAlpha = 0.16;
          ctx.fillRect(0, 0, w, hg);
          ctx.globalAlpha = 1;
          T.tick++;
          if (T.particles.length < 32 && T.tick % 3 === 0) {
            const fromLeft = Math.random() < 0.5;
            T.particles.push({
              x: fromLeft ? -P : w + P,
              y: hg * (0.15 + Math.random() * 0.7),
              vx: (fromLeft ? 1 : -1) * (1.5 + Math.random() * 2),
              vy: (Math.random() - 0.5) * 1.5,
              life: 45 + Math.random() * 35,
              trail: [],
            });
          }
          T.particles = T.particles.filter(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.life--;
            p.trail.unshift({ x: p.x, y: p.y });
            p.trail.length = Math.min(p.trail.length, 12);
            p.trail.forEach((point, i) => {
              ctx.globalAlpha = (1 - i / p.trail.length) * Math.min(1, p.life / 12);
              ctx.fillStyle = colorPaint;
              ctx.fillRect(point.x, point.y, P * 2, P * 2);
            });
            ctx.globalAlpha = 1;
            return p.life > 0 && p.x > -P * 3 && p.x < w + P * 3 && p.y > -P * 3 && p.y < hg + P * 3;
          });
          break;
        }
        case 'twister': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const T = modeData.twister;
          T.angle += 0.035;
          const rows = 36, columns = 8;
          const halfWidth = Math.min(w * 0.34, hg * 0.28);
          const halfHeight = hg * 0.42;
          const cx = w / 2, cy = hg / 2, dist = 4;
          const project = (u, v) => {
            const y = (u / rows * 2 - 1) * halfHeight;
            const across = (v / columns * 2 - 1) * halfWidth;
            const angle = T.angle + u / rows * Math.PI * 4;
            const x = across * Math.cos(angle);
            const z = across * Math.sin(angle);
            const persp = dist / (dist + z / (halfWidth || 1));
            return { x: cx + x * persp, y: cy + y * persp, z };
          };
          for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
              const a = project(row, column), b = project(row + 1, column);
              const c = project(row + 1, column + 1), d = project(row, column + 1);
              const z = (a.z + b.z + c.z + d.z) / 4;
              const shade = Math.max(0.25, Math.min(1.5, 0.65 + z / (halfWidth * 2)));
              ctx.fillStyle = _spacerRgb(h, (a.x + b.x + c.x + d.x) / 4, w, shade);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.lineTo(c.x, c.y);
              ctx.lineTo(d.x, d.y);
              ctx.closePath();
              ctx.fill();
            }
          }
          break;
        }
        case 'fluid': {
          const F = modeData.fluid;
          F.time += 0.035;
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const cols = 28, rows = 18;
          const planeW = Math.min(w * 0.84, hg * 1.75);
          const planeH = Math.min(hg * 0.55, w * 0.52);
          const cx = w / 2, cy = hg * 0.58;
          const vortices = [
            { x: Math.sin(F.time * 0.7) * 0.38, y: Math.cos(F.time * 0.53) * 0.32, phase: F.time * 2 },
            { x: Math.cos(F.time * 0.43 + 1) * 0.34, y: Math.sin(F.time * 0.61 + 2) * 0.3, phase: -F.time * 1.5 },
          ];
          const heightAt = (u, v) => {
            let height = Math.sin(u * 12 + F.time * 1.6) * Math.cos(v * 9 - F.time) * 0.035;
            vortices.forEach(blob => {
              const dx = u - blob.x, dy = v - blob.y;
              const distance = Math.sqrt(dx * dx + dy * dy);
              height += Math.sin(distance * 34 - blob.phase) * Math.exp(-distance * 5) * 0.18;
            });
            return height;
          };
          const project = (u, v, z) => ({
            x: cx + u * planeW * (0.48 + v * 0.1) + z * planeW * 0.12,
            y: cy + v * planeH - z * planeH * 1.7,
          });
          const grid = Array.from({ length: rows + 1 }, (_, row) =>
            Array.from({ length: cols + 1 }, (_, column) => {
              const u = column / cols * 2 - 1, v = row / rows * 2 - 1;
              const z = heightAt(u, v);
              return { ...project(u, v, z), u, v, z };
            })
          );
          ctx.fillStyle = 'rgba(20, 45, 68, 0.65)';
          ctx.beginPath();
          const backLeft = project(-1, -1, -0.12);
          ctx.moveTo(backLeft.x, backLeft.y);
          [[1, -1], [1, 1], [-1, 1]].forEach(([u, v]) => {
            const point = project(u, v, -0.12);
            ctx.lineTo(point.x, point.y);
          });
          ctx.closePath();
          ctx.fill();
          for (let row = 0; row < rows; row++) {
            for (let column = 0; column < cols; column++) {
              const a = grid[row][column], b = grid[row][column + 1];
              const c = grid[row + 1][column + 1], d = grid[row + 1][column];
              const slopeX = (b.z - a.z) * cols, slopeY = (d.z - a.z) * rows;
              const light = Math.max(0.28, Math.min(1.3, 0.72 - slopeX * 0.7 - slopeY * 0.45 + Math.max(0, a.z) * 1.2));
              ctx.fillStyle = _spacerRgb(h, cx + a.u * planeW * 0.48, w, light);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.lineTo(c.x, c.y);
              ctx.lineTo(d.x, d.y);
              ctx.closePath();
              ctx.fill();
              if ((row + column) % 2 === 0) {
                ctx.strokeStyle = 'rgba(210, 245, 255, 0.14)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(c.x, c.y);
                ctx.stroke();
              }
            }
          }
          ctx.strokeStyle = 'rgba(190, 225, 240, 0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].forEach(([u, v]) => {
            const point = project(u, v, 0);
            if (u === -1 && v === -1) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          });
          ctx.stroke();
          break;
        }
        case 'cursor': {
          const C = modeData.cursor;
          const style = _cursorStyle(h);
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          const cols = Math.max(1, Math.ceil(w / style.spacing));
          const rows = Math.max(1, Math.ceil(hg / style.spacing));
          const points = Array.from({ length: rows + 1 }, (_, row) =>
            Array.from({ length: cols + 1 }, (_, column) => {
              const bx = column / cols * w, by = row / rows * hg;
              const dx = bx - C.x * w, dy = by - C.y * hg;
              const distance = Math.hypot(dx, dy);
              const falloff = Math.exp(-distance / style.radius);
              const push = falloff * style.radius * 0.28 * style.strength;
              const wave = Math.sin(distance / Math.max(8, style.spacing * 0.75) - h.t * style.speed * 0.12) *
                falloff * style.radius * 0.12 * style.strength;
              const amount = distance > 0 ? (push + wave) / distance : 0;
              return { x: bx + dx * amount, y: by + dy * amount };
            })
          );
          for (let row = 0; row <= rows; row++) {
            for (let column = 0; column <= cols; column++) {
              const point = points[row][column];
              const colorX = column / cols * w;
              ctx.fillStyle = _spacerRgb(h, colorX, w, 0.8 + 0.2 * Math.sin(h.t * 0.04 + row * 0.3));
              ctx.beginPath();
              ctx.arc(point.x, point.y, style.dotSize, 0, Math.PI * 2);
              ctx.fill();
              if (column < cols) {
                const next = points[row][column + 1];
                ctx.strokeStyle = _cursorRgba(style.spacingColor, 0.36 * style.spacingOpacity);
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(next.x, next.y); ctx.stroke();
              }
              if (row < rows) {
                const next = points[row + 1][column];
                ctx.strokeStyle = _cursorRgba(style.spacingColor, 0.24 * style.spacingOpacity);
                ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(next.x, next.y); ctx.stroke();
              }
            }
          }
          _drawCursorRipples(ctx, C, style, w, hg, style.radius * 3);
          _drawCursorMarker(ctx, C, style, w, hg);
          break;
        }
        case 'cursor-ripple': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          _drawCursorRipple(ctx, h, modeData.cursor, _cursorStyle(h), w, hg);
          break;
        }
        case 'cursor-particles': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          _drawCursorParticles(ctx, h, modeData.cursor, _cursorStyle(h), w, hg);
          break;
        }
        case 'cursor-radar': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          _drawCursorRadar(ctx, h, modeData.cursor, _cursorStyle(h), w, hg);
          break;
        }
        case 'physics-demo': {
          _drawPhysicsDemo(ctx, h, modeData.physicsDemo, w, hg, colorPaint);
          break;
        }
        case 'bouncing-ball': {
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
          _drawBouncingBall(ctx, modeData.bouncingBall, w, hg, colorPaint);
          break;
        }
        case 'defrag-map': {
          _drawDefragMap(ctx, h, modeData.defragMap, w, hg, colorPaint);
          break;
        }
        case 'chat-interactive': {
          _drawChatInteractive(ctx, h, modeData.chatInteractive, w, hg, colorPaint);
          break;
        }
        case 'card-cascade': {
          _drawCardCascade(ctx, h, modeData.cardCascade, w, hg, colorPaint);
          break;
        }
        case 'pointer-debug': {
          const D = modeData.pointerDebug;
          const msg = D.last;
          const age = D.lastAt === null ? null : Math.max(0, performance.now() - D.lastAt);
          const validPosition = msg && Number.isFinite(msg.x) && Number.isFinite(msg.y);
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);

          ctx.fillStyle = colorPaint;
          ctx.font = 'bold 16px monospace';
          ctx.fillText('GLOBAL POINTER DEBUG', 12, 24, Math.max(0, w - 24));
          ctx.font = '12px monospace';
          ctx.fillStyle = msg ? '#a7f3d0' : '#ff8b8b';
          ctx.fillText(
            msg ? `RECEIVING · ${D.messageCount} messages · ${Math.round(age)} ms ago` : 'NO POINTER MESSAGES RECEIVED',
            12, 46, Math.max(0, w - 24)
          );

          ctx.fillStyle = '#e5e7eb';
          const normalized = validPosition
            ? `normalized: x=${Number(msg.x).toFixed(4)}  y=${Number(msg.y).toFixed(4)}`
            : 'normalized: unavailable';
          ctx.fillText(normalized, 12, 68, Math.max(0, w - 24));
          const mapped = validPosition
            ? `panel mapping: x=${Math.round(msg.x * w)}  y=${Math.round(msg.y * hg)}  (${Math.round(w)}x${Math.round(hg)})`
            : 'panel mapping: unavailable';
          ctx.fillText(mapped, 12, 88, Math.max(0, w - 24));
          const screen = msg && Number.isFinite(msg.screen_x) && Number.isFinite(msg.screen_y)
            ? `screen: x=${msg.screen_x}  y=${msg.screen_y}  desktop=${msg.screen_width}x${msg.screen_height}`
            : 'screen: raw coordinates unavailable';
          ctx.fillText(screen, 12, 108, Math.max(0, w - 24));
          ctx.fillText(
            `action: ${msg ? msg.action : '—'}  buttons: ${msg ? msg.buttons : '—'}  button: ${msg ? msg.button : '—'}`,
            12, 128, Math.max(0, w - 24)
          );

          if (validPosition) {
            const x = Math.max(0, Math.min(w, msg.x * w));
            const y = Math.max(0, Math.min(hg, msg.y * hg));
            ctx.strokeStyle = colorPaint;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0); ctx.lineTo(x, hg);
            ctx.moveTo(0, y); ctx.lineTo(w, y);
            ctx.stroke();
            ctx.fillStyle = colorPaint;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        default:
          ctx.fillStyle = _spacerBackground(h);
          ctx.fillRect(0, 0, w, hg);
      }
      h.raf = requestAnimationFrame(frame);
    }
    frame();
  }

 
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
      typeIn(h.body, 40);
      if (h.hideTimer) clearTimeout(h.hideTimer);
      h.hideTimer = setTimeout(() => wm.showPopup(winId, false), 6000);
    },
    applyOpts(h, win) {
      if (win.opts && win.opts.bg_color) h.body.style.backgroundColor = win.opts.bg_color;
    },
  };

 
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

  const notepadCache = new Map();
  let latestCache = { follower: '', sub: '' };
  const chatCache = [];
  let pointerCache = {
    x: 0.5, y: 0.5, buttons: 0, button: -1, action: 'leave', pointer_type: 'mouse',
  };
  function cacheMsg(key, msg) {
    if (key === 'notepad' && msg) notepadCache.set(msg.id, msg.value || '');
    else if (key === 'latest') latestCache = msg || { follower: '', sub: '' };
    else if (key === 'pointer' && msg) pointerCache = msg;
    else if (key === 'chat' && msg) {
      chatCache.push(msg);
      if (chatCache.length > 40) chatCache.shift();
    }
    else if (key === 'message' || key === 'status') textCache[key] = (msg && msg.value) || '';
  }

  let fxStyled = false;
  function ensureFxStyles() {
    if (fxStyled) return;
    fxStyled = true;
    const st = document.createElement('style');
    st.textContent = `
@keyframes fxwave{0%,100%{transform:translateY(-.22em)}50%{transform:translateY(.22em)}}
@keyframes fxorbit{0%{transform:translate(.08em,0)}25%{transform:translate(0,.08em)}50%{transform:translate(-.08em,0)}75%{transform:translate(0,-.08em)}100%{transform:translate(.08em,0)}}
@keyframes fxshake{0%{transform:translate(.04em,.03em) rotate(2deg)}20%{transform:translate(-.05em,.02em) rotate(-3deg)}40%{transform:translate(.03em,-.05em) rotate(1deg)}60%{transform:translate(-.03em,-.03em) rotate(-2deg)}80%{transform:translate(.05em,.04em) rotate(3deg)}100%{transform:translate(0,0)}}
@keyframes fxhop{0%,100%{transform:translateY(0) scaleY(.9)}40%{transform:translateY(-.45em) scaleY(1.1)}70%{transform:translateY(0) scaleY(.85)}}
@keyframes fxgrow{0%,100%{transform:scale(1)}50%{transform:scale(1.4)}}
@keyframes fxgrad{to{background-position-x:4em}}`;
    document.head.appendChild(st);
  }
  function fxChars(html, anim, dur, step, timing) {
    let i = 0;
    return html.replace(/(<[^>]+>)|(&[#\w]+;|[\s\S])/g, (m, tag, ch) => {
      if (tag) return tag;
      const d = (-(i++) * step).toFixed(2);
      return `<span style="display:inline-block;white-space:pre;animation:${anim} ${dur}s ${timing} ${d}s infinite">${ch}</span>`;
    });
  }
  function fx(s) {
    ensureFxStyles();
    const R = (re, f) => { s = s.replace(re, f); };
    R(/\*\^\*\^(.+?)\*\^\*\^/g, (m, t) => `<span style="font-weight:900;font-size:1.25em">${t}</span>`);
    R(/%\$(.+?)\$%/g, (m, t) => `<span style="font-family:monospace;letter-spacing:.06em;text-rendering:optimizeSpeed;-webkit-font-smoothing:none;text-shadow:1px 0 currentColor,0 1px currentColor">${t}</span>`);
    R(/\$!(.+?)!\$/g, (m, t) => `<span style="text-shadow:0 0 3px currentColor,0 0 8px currentColor,0 0 16px currentColor,0 0 28px currentColor">${t}</span>`);
    R(/##([0-9a-fA-F]{3,6})\|([0-9a-fA-F]{3,6}):(.+?)##/g, (m, a, b, t) => `<span style="background-image:linear-gradient(90deg,#${a},#${b},#${a});background-size:4em auto;background-repeat:repeat-x;-webkit-background-clip:text;background-clip:text;color:transparent;animation:fxgrad 2s linear infinite">${t}</span>`);
    R(/##([0-9a-fA-F]{3,6}):(.+?)##/g, (m, c, t) => `<span style="color:#${c}">${t}</span>`);
    R(/!\*(.+?)\*!/g, (m, t) => fxChars(t, 'fxshake', 0.3, 0.07, 'steps(1)'));
    R(/&gt;\*(.+?)\*&lt;/g, (m, t) => fxChars(t, 'fxgrow', 1.2, 0.1, 'ease-in-out'));
    R(/\^&gt;(.+?)&lt;\^/g, (m, t) => fxChars(t, 'fxhop', 0.9, 0.09, 'ease-in-out'));
    R(/-#(.+?)#-/g, (m, t) => fxChars(t, 'fxwave', 1.6, 0.12, 'ease-in-out'));
    R(/\(#(.+?)#\)/g, (m, t) => fxChars(t, 'fxorbit', 0.9, 0.13, 'linear'));
    R(/%(.+?)%/g, (m, t) => `<span style="font-size:.7em;vertical-align:super">${t}</span>`);
    return s;
  }
  function rich(t) { return mdInline(escapeHtml(t)); }

  function mdInline(s) {
    return fx(s).replace(/`([^`]+)`/g, '<code>$1</code>')
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
    if ((m = e.match(/^&gt;\s(.*)$/))) return `<div style="opacity:.7;border-left:2px solid currentColor;padding-left:6px">${mdInline(m[1])}</div>`;
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
    now_playing, lyrics, status, socials, message_bar, screen, chat, extra, spacer,
    key_panel, alerts, redeem_player, pngtuber, words, tts_transcript, ad_warning, canvas,
    notepad, latest, status_text, cacheMsg, escapeHtml, SPACER_COLOR_DEFAULTS,
  };
})();