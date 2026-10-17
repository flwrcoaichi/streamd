// music-panels.js — customizable "now playing" + animated "lyrics" panels.
// Load AFTER panels.js (overlay.html and control.html); it replaces Panels.now_playing and Panels.lyrics.
(() => {
  const $c = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rgb = hex => {
    let h = (hex || '').replace('#', '');
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return isNaN(n) || h.length !== 6 ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const textOpts = (body, o) => {
    o = o || {};
    body.style.color = o.text_color || '';
    body.style.backgroundColor = o.bg_color || '';
    body.style.fontSize = (o.font_size || 13) + 'px';
    body.style.fontFamily = o.font_family === 'sans-serif' ? 'sans-serif' : 'monospace';
  };
  // keep a muted <video> following the player's position
  function syncVideo(video, m) {
    if (!video || !video.getAttribute('src') || !m) return;
    if (m.playing) { if (video.paused) video.play().catch(() => {}); } else video.pause();
    const target = Number(m.position) || 0;
    if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target;
  }

  const NP_DEFAULTS = {
    np_layout: 'inline', np_align: 'left', np_valign: 'bottom',
    np_title_size: 14, np_artist_size: 12,
    np_art_brightness: 55,
    np_grad_color: '#000000', np_grad_opacity: 75, np_grad_height: 60,
    np_icon_show: true, np_icon_playing: '▶', np_icon_paused: '⏸', np_icon_size: 12,
    np_artist_show: true, np_marquee: true,
    np_progress_show: false, np_progress_color: '#ffb238', np_progress_height: 3,
  };
  const LY_DEFAULTS = {
    ly_align: 'left', ly_scale: 108, ly_blur: 3, ly_dim: 45, ly_scroll_ms: 500, ly_offset: 0,
    ly_active_color: '#ffb238', ly_sweep: true, ly_glow: false,
    ly_lift: 3, ly_art_bg: false, ly_art_blur: 18, ly_art_dim: 35,
  };

  const st = document.createElement('style');
  st.textContent = `
.np-fg{position:absolute;left:0;right:0;display:flex;gap:8px;align-items:baseline;padding:6px 10px;z-index:2;box-sizing:border-box}
.np-text{min-width:0;display:flex;gap:6px;align-items:baseline}
.np-text.stacked{display:block}
.np-track-wrap{min-width:0;overflow:hidden;white-space:nowrap}
.np-track{display:inline-block;font-weight:700;white-space:nowrap;overflow:visible;text-overflow:clip}
.np-track.marquee{animation:npslide var(--np-dur,8s) ease-in-out infinite alternate}
@keyframes npslide{0%,12%{transform:translateX(0)}88%,100%{transform:translateX(var(--np-shift,0px))}}
.np-artist{opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.np-progress{position:absolute;left:0;right:0;bottom:0;z-index:3;background:rgba(255,255,255,.12)}
.np-progress-fill{height:100%;width:0;transition:width .35s linear}

.ly-viewport{position:absolute;inset:8px 10px;overflow:hidden;
  -webkit-mask-image:linear-gradient(transparent 0,#000 18%,#000 82%,transparent 100%);
  mask-image:linear-gradient(transparent 0,#000 18%,#000 82%,transparent 100%)}
.ly-track{position:relative;transition:transform var(--ly-ms,500ms) cubic-bezier(.2,.7,.2,1);will-change:transform}
.ly-line{padding:3px 0;text-align:var(--ly-align,left);white-space:pre-wrap;transform-origin:var(--ly-origin,left) center;
  opacity:var(--ly-dim,.45);filter:blur(calc(var(--ly-blur,0) * 1px * var(--d,3) / 3));
  transition:opacity .35s,filter .35s,transform .35s}
.ly-line.active{opacity:1;transform:scale(var(--ly-scale,1.08))}
.ly-line.active:not(.sw){color:var(--ly-active);text-shadow:var(--ly-glow,none)}
.ly-line.empty{opacity:calc(var(--ly-dim,.45) * .6)}
.ly-line.ly-none{opacity:.5;filter:none}
.ly-w{position:relative;display:inline-block}
.ly-w::after{content:attr(data-t);position:absolute;left:0;top:0;width:var(--p,0%);overflow:hidden;white-space:nowrap;
  color:var(--ly-active);text-shadow:var(--ly-glow,none)}
.ly-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}
.ly-art{position:absolute;inset:-24px;background-size:cover;background-position:center;display:none;
  filter:blur(var(--ly-art-blur,18px)) brightness(var(--ly-art-dim,.35));animation:lydrift 24s ease-in-out infinite alternate}
@keyframes lydrift{from{transform:scale(1.1)}to{transform:scale(1.28) translate(2%,-2%)}}
.ly-w{transition:transform .25s}
.ly-w.sung{transform:translateY(calc(var(--ly-lift,0) * -1px))}`;
  document.head.appendChild(st);

  // ── now playing ───────────────────────────────────────────────────────
  function npApply(h, win) {
    h.win = win;
    const o = h.o = Object.assign({}, NP_DEFAULTS, win && win.opts);
    const [r, g, b] = rgb(o.np_grad_color);
    const top = o.np_valign === 'top';
    const a = clamp(Number(o.np_grad_opacity), 0, 100) / 100, hgt = clamp(Number(o.np_grad_height), 0, 100);
    h.grad.style.background = top
      ? `linear-gradient(to bottom, rgba(${r},${g},${b},${a}) 0%, rgba(${r},${g},${b},0) ${hgt}%)`
      : `linear-gradient(to bottom, rgba(${r},${g},${b},0) ${100 - hgt}%, rgba(${r},${g},${b},${a}) 100%)`;
    h.art.style.filter = h.video.style.filter = `brightness(${clamp(Number(o.np_art_brightness), 0, 150) / 100})`;

    const fg = h.fg.style, barH = o.np_progress_show ? clamp(Number(o.np_progress_height) || 3, 1, 20) : 0;
    fg.top = top ? '0' : 'auto';
    fg.bottom = top ? 'auto' : '0';
    fg.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[o.np_align] || 'flex-start';
    fg.textAlign = o.np_align;
    fg.paddingBottom = (top ? 6 : 6 + barH) + 'px';
    h.text.classList.toggle('stacked', o.np_layout === 'stacked');
    h.track.style.fontSize = o.np_title_size + 'px';
    h.artist.style.fontSize = o.np_artist_size + 'px';
    h.artist.style.display = o.np_artist_show ? '' : 'none';
    h.status.style.display = o.np_icon_show ? '' : 'none';
    h.status.style.fontSize = o.np_icon_size + 'px';
    h.bar.style.display = barH ? '' : 'none';
    h.bar.style.height = barH + 'px';
    h.fill.style.background = o.np_progress_color;
    npText(h, true);
    npIcon(h);
    npProgress(h);
  }
  function npIcon(h) {
    h.status.textContent = h.music && h.music.playing ? h.o.np_icon_playing : h.o.np_icon_paused;
  }
  function npText(h, force) {
    const m = h.music || {};
    const title = m.title || '—';
    const artist = m.artist ? (h.o.np_layout === 'stacked' ? m.artist : `— ${m.artist}`) : '';
    if (!force && h.track.textContent === title && h.artist.textContent === artist) return;
    h.track.textContent = title;
    h.artist.textContent = artist;
    h.track.classList.remove('marquee');
    h.track.style.removeProperty('--np-shift');
    if (!h.o.np_marquee) return;
    requestAnimationFrame(() => {
      const over = h.track.scrollWidth - h.wrap.clientWidth;
      if (over > 4) {
        h.track.style.setProperty('--np-shift', `-${over}px`);
        h.track.style.setProperty('--np-dur', Math.max(5, over / 20) + 's');
        h.track.classList.add('marquee');
      }
    });
  }
  function npProgress(h) {
    const m = h.music;
    if (!h.o.np_progress_show || !m || !(m.duration > 0)) { h.fill.style.width = '0'; return; }
    const pos = m.position + (m.playing ? (performance.now() - h.musicAt) / 1000 : 0);
    h.fill.style.width = clamp(pos / m.duration * 100, 0, 100) + '%';
  }
  function npArt(h) {
    const set = () => { h.art.style.backgroundImage = `url('/art.png?t=${Date.now()}')`; };
    set();
    // the bridge writes art.png a moment after announcing the track
    setTimeout(set, 1500);
  }

  const now_playing = {
    mount(body, win) {
      body.innerHTML = `
        <div class="np-bg"><div class="np-art"></div><video class="np-video" autoplay loop muted playsinline></video><div class="np-grad"></div></div>
        <div class="np-fg"><span class="np-status">▶</span><div class="np-text"><div class="np-track-wrap"><span class="np-track">—</span></div><span class="np-artist"></span></div></div>
        <div class="np-progress"><div class="np-progress-fill"></div></div>`;
      const q = s => body.querySelector(s);
      const h = {
        body, win, o: {}, music: null, musicAt: 0, lastKey: '',
        art: q('.np-art'), video: q('.np-video'), grad: q('.np-grad'), fg: q('.np-fg'), text: q('.np-text'),
        wrap: q('.np-track-wrap'), track: q('.np-track'), artist: q('.np-artist'), status: q('.np-status'),
        bar: q('.np-progress'), fill: q('.np-progress-fill'),
      };
      npApply(h, win);
      return h;
    },
    onState(h, key, msg) {
      if (key === 'music') {
        h.music = msg;
        h.musicAt = performance.now();
        npIcon(h);
        npText(h, false);
        npProgress(h);
        const k = `${msg.title}::${msg.artist}`;
        if (k !== h.lastKey) {
          h.lastKey = k;
          if (msg.title && msg.title !== '—') npArt(h); else h.art.style.backgroundImage = '';
        }
        if (h.video.classList.contains('active')) syncVideo(h.video, msg);
      } else if (key === 'music_video') {
        if (msg.url) {
          h.video.src = msg.url;
          h.video.onloadedmetadata = () => syncVideo(h.video, h.music);
          h.video.classList.add('active');
        } else {
          h.video.classList.remove('active');
          h.video.removeAttribute('src');
        }
      } else if (key === 'tick') {
        npProgress(h);
      }
    },
    applyOpts(h, win) { npApply(h, win); },
  };

  // ── lyrics ────────────────────────────────────────────────────────────
  function lyElapsed(h) {
    const m = h.musicState;
    return m.playing ? m.position + (performance.now() - m._updatedAt) / 1000 : m.position;
  }
  function lyIndexAt(lines, t) {
    let lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }
  // lines = synced (lrc) lines, or plain lines spread evenly over the song
  // every synced line gets word timings: real ones from ttml, otherwise estimated
  function lyLines(h) {
    const d = h.data, dur = h.musicState.duration || 180;
    let lines;
    h.synthetic = false;
    if (d.synced_lines.length) lines = d.synced_lines.map(l => ({ time: Number(l.time) || 0, text: l.text || '' }));
    else if (d.plain_lines.length) {
      h.synthetic = true;
      lines = d.plain_lines.map((t, i) => ({ time: i / d.plain_lines.length * dur, text: t || '' }));
    } else return [];
    lines.forEach((ln, i) => { ln.end = lines[i + 1] ? lines[i + 1].time : ln.time + 5; });
    if (h.synthetic) return lines;
    const ws = d.synced_words;
    lines.forEach(ln => {
      if (!ln.text) return;
      const own = ws.length ? ws.filter(w => w.time >= ln.time - 0.05 && w.time < ln.end) : [];
      if (own.length) {
        ln.words = own.map((w, k) => ({ word: w.word, time: w.time, end: w.end || (own[k + 1] ? own[k + 1].time : ln.end) }));
      } else {
        const parts = ln.text.split(/\s+/).filter(Boolean), chars = parts.join('').length || 1;
        const span = Math.min(ln.end - ln.time, Math.max(1.5, ln.text.length / 12));
        let t = ln.time;
        ln.words = parts.map(p => { const dt = span * p.length / chars; const w = { word: p, time: t, end: t + dt }; t += dt; return w; });
      }
    });
    return lines;
  }
  function lyBuild(h) {
    h.track.innerHTML = '';
    h.els = [];
    h.activeIdx = -2;
    h.dirty = true;
    h.builtSweep = !!h.o.ly_sweep;
    h.builtDur = h.musicState.duration;
    h.lines = lyLines(h);
    if (!h.lines.length) {
      h.track.innerHTML = `<div class="ly-line ly-none">${h.hasData ? 'no lyrics' : '—'}</div>`;
      h.track.style.transform = 'translateY(0)';
      return;
    }
    h.lines.forEach(ln => {
      const el = $c('div', 'ly-line');
      el.style.setProperty('--d', 3);
      if (!ln.text) { el.classList.add('empty'); el.textContent = '♪'; }
      else if (h.o.ly_sweep && ln.words) {
        el.classList.add('sw');
        ln.words.forEach((w, i) => {
          if (i) el.appendChild(document.createTextNode(' '));
          const s = $c('span', 'ly-w');
          s.textContent = w.word;
          s.dataset.t = w.word;
          el.appendChild(s);
        });
        el._ws = Array.from(el.querySelectorAll('.ly-w'));
        el._p = [];
      } else el.textContent = ln.text;
      h.track.appendChild(el);
      h.els.push(el);
    });
  }
  function lyApply(h, win) {
    h.win = win;
    const o = h.o = Object.assign({}, LY_DEFAULTS, win && win.opts);
    textOpts(h.body, win && win.opts);
    const s = h.body.style, c = o.ly_active_color;
    s.setProperty('--ly-active', c);
    s.setProperty('--ly-dim', clamp(Number(o.ly_dim), 0, 100) / 100);
    s.setProperty('--ly-blur', clamp(Number(o.ly_blur), 0, 12));
    s.setProperty('--ly-scale', clamp(Number(o.ly_scale), 100, 160) / 100);
    s.setProperty('--ly-ms', clamp(Number(o.ly_scroll_ms), 0, 3000) + 'ms');
    s.setProperty('--ly-align', o.ly_align);
    s.setProperty('--ly-origin', o.ly_align);
    s.setProperty('--ly-glow', o.ly_glow ? `0 0 6px ${c}, 0 0 16px ${c}` : 'none');
    s.setProperty('--ly-lift', clamp(Number(o.ly_lift), 0, 10));
    s.setProperty('--ly-art-blur', clamp(Number(o.ly_art_blur), 0, 40) + 'px');
    s.setProperty('--ly-art-dim', clamp(Number(o.ly_art_dim), 0, 100) / 100);
    if (h.art) h.art.style.display = o.ly_art_bg ? 'block' : 'none';
    if (h.builtSweep !== null && h.builtSweep !== !!o.ly_sweep) lyBuild(h);
    h.dirty = true;
  }
  function lyCenter(h) {
    const el = h.els[Math.max(0, h.activeIdx)];
    if (!el) { h.track.style.transform = 'translateY(0)'; return; }
    const y = h.viewport.clientHeight / 2 - (el.offsetTop + el.offsetHeight / 2);
    h.track.style.transform = `translateY(${Math.min(0, y)}px)`;
  }
  function lySetActive(h, idx) {
    const prev = h.els[h.activeIdx];
    if (prev && prev._ws) { prev._ws.forEach(w => { w.style.setProperty('--p', '0%'); w.classList.remove('sung'); }); prev._p = []; }
    h.activeIdx = idx;
    h.dirty = false;
    h.els.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.style.setProperty('--d', Math.min(Math.abs(i - idx), 3));
    });
    lyCenter(h);
  }
  function lySweep(h, idx, t) {
    const ln = h.lines[idx], el = h.els[idx];
    if (!ln || !ln.words || !el || !el._ws) return;
    ln.words.forEach((w, i) => {
      const v = Math.round(clamp((t - w.time) / Math.max(0.05, w.end - w.time), 0, 1) * 100);
      if (el._p[i] !== v) { el._p[i] = v;  el._ws[i].classList.toggle('sung', v > 0); el._ws[i].style.setProperty('--p', v + '%'); }
    });
  }
  function lyFrame(h) {
    if (h.lines.length) {
      const t = lyElapsed(h) + (Number(h.o.ly_offset) || 0) / 1000;
      const idx = lyIndexAt(h.lines, t);
      if (idx !== h.activeIdx || h.dirty) lySetActive(h, idx);
      if (h.o.ly_sweep && idx >= 0) lySweep(h, idx, t);
      if (h.viewport.clientHeight !== h.vh) { h.vh = h.viewport.clientHeight; lyCenter(h); }
    }
    h.raf = requestAnimationFrame(() => lyFrame(h));
  }
  function lyVideo(h, url) {
    if (url) {
      if (h.video.getAttribute('src') !== url) {
        h.video.src = url;
        h.video.onloadedmetadata = () => syncVideo(h.video, { playing: h.musicState.playing, position: lyElapsed(h) });
      }
      h.video.style.display = 'block';
      h.viewport.style.display = 'none';
    } else {
      h.video.removeAttribute('src');
      h.video.style.display = 'none';
      h.viewport.style.display = '';
    }
  }

  const lyrics = {
    mount(body, win) {
      body.classList.add('wm-term');
      const viewport = $c('div', 'ly-viewport'), track = $c('div', 'ly-track');
      viewport.appendChild(track);
      const video = $c('video', 'ly-video');
      video.muted = true;
      video.playsInline = true;
      body.append(viewport, video);
      const art = $c('div', 'ly-art');
      body.append(art, viewport, video);
      const h = { body, win, art, viewport, track, video, lastKey: '', 
        o: {}, lines: [], els: [], activeIdx: -2, dirty: true, vh: 0,
        builtSweep: null, builtDur: 0, synthetic: false, hasData: false, raf: null,
        data: { synced_lines: [], synced_words: [], plain_lines: [] },
        musicState: { playing: false, duration: 0, position: 0, _updatedAt: 0 },
      };
      
      lyApply(h, win);
      lyBuild(h);
      lyFrame(h);
      return h;
    },
    onState(h, key, msg) {
      if (key === 'music') {
        const k = `${msg.title}::${msg.artist}`;
        if (k !== h.lastKey) {
          h.lastKey = k;
          setTimeout(() => { h.art.style.backgroundImage = `url('/art.png?t=${Date.now()}')`; }, 1200);
        }
        h.musicState = {
          playing: msg.playing, duration: Number(msg.duration) || 0,
          position: Number(msg.position) || 0, _updatedAt: performance.now(),
        };
        syncVideo(h.video, msg);
        // evenly-spread plain lyrics depend on the song length, which can arrive after the lyrics
        if (h.synthetic && h.musicState.duration && Math.abs(h.musicState.duration - h.builtDur) > 1) lyBuild(h);
      } else if (key === 'lyrics') {
        lyVideo(h, msg.video_url);
        h.hasData = true;
        h.data = msg.found
          ? { synced_lines: msg.synced_lines || [], synced_words: msg.synced_words || [], plain_lines: msg.plain_lines || msg.lines || [] }
          : { synced_lines: [], synced_words: [], plain_lines: [] };
        lyBuild(h);
      }
    },
    applyOpts(h, win) { lyApply(h, win); },
    unmount(h) { if (h.raf) cancelAnimationFrame(h.raf); },
  };

  Panels.now_playing = now_playing;
  Panels.lyrics = lyrics;
  Panels.NP_DEFAULTS = NP_DEFAULTS;
  Panels.LY_DEFAULTS = LY_DEFAULTS;
})();
