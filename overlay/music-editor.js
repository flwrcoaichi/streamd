// music-editor.js — inspector fields for the now_playing and lyrics windows.
(() => {
  const $ = id => document.getElementById(id);
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const POS = ['left', 'center', 'right'];
  const SCHEMAS = {
    now_playing: { title: 'now playing', defaults: () => Panels.NP_DEFAULTS, fields: [
      ['np_layout', 'layout', 'select', ['inline', 'stacked']],
      ['np_align', 'horizontal align', 'select', POS],
      ['np_valign', 'vertical position', 'select', ['bottom', 'top']],
      ['np_title_size', 'title size', 'range', 8, 72],
      ['np_artist_size', 'artist size', 'range', 8, 72],
      ['np_artist_show', 'show artist', 'bool'],
      ['np_marquee', 'scroll long titles', 'bool'],
      ['np_art_brightness', 'art brightness %', 'range', 0, 150],
      ['np_grad_color', 'gradient color', 'color'],
      ['np_grad_opacity', 'gradient opacity %', 'range', 0, 100],
      ['np_grad_height', 'gradient height %', 'range', 0, 100],
      ['np_icon_show', 'show play/pause icon', 'bool'],
      ['np_icon_playing', 'playing icon', 'text'],
      ['np_icon_paused', 'paused icon', 'text'],
      ['np_icon_size', 'icon size', 'range', 6, 48],
      ['np_progress_show', 'progress bar', 'bool'],
      ['np_progress_color', 'progress color', 'color'],
      ['np_progress_height', 'progress height', 'range', 1, 20],
    ] },
    lyrics: { title: 'lyrics', defaults: () => Panels.LY_DEFAULTS, fields: [
      ['ly_align', 'align', 'select', POS],
      ['ly_active_color', 'active line color', 'color'],
      ['ly_sweep', 'word-by-word sweep', 'bool'],
      ['ly_lift', 'sung word lift (px)', 'range', 0, 10],
      ['ly_glow', 'glow', 'bool'],
      ['ly_scale', 'active line scale %', 'range', 100, 160],
      ['ly_blur', 'distance blur', 'range', 0, 12],
      ['ly_dim', 'inactive opacity %', 'range', 0, 100],
      ['ly_scroll_ms', 'scroll time (ms)', 'range', 0, 3000],
      ['ly_offset', 'sync offset (ms)', 'range', -2000, 2000],
      ['ly_art_bg', 'blurred album art background', 'bool'],
      ['ly_art_blur', 'art blur (px)', 'range', 0, 40],
      ['ly_art_dim', 'art brightness %', 'range', 0, 100],
    ] },
  };
  const groups = {};     // panel -> { root, inputs }
  let commitTimer = null;

  const curWin = () => {
    let id = null;
    try { id = selectedWinId; } catch (e) { /* not ready */ }
    const w = id && wm.getWindow(id);
    return w && SCHEMAS[w.panel] ? w : null;
  };
  function setOpt(key, val, silent) {
    const w = curWin();
    if (!w) return;
    wm.updateWindow(w.id, { opts: { ...(w.opts || {}), [key]: val } }, silent ? { silent: true } : undefined);
  }
  const later = (key, val) => {            // live preview now, one undo step shortly after
    setOpt(key, val, true);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => setOpt(key, val, false), 350);
  };

  function build(panel, host) {
    const schema = SCHEMAS[panel];
    const root = el('div');
    const head = el('div', 'ee-title'); head.textContent = schema.title + ' options';
    root.appendChild(head);
    const inputs = {};
    schema.fields.forEach(([key, label, type, a, b]) => {
      const wrap = el('div', 'field'), lab = el('label');
      let input, out = null;
      if (type === 'select') {
        input = el('select');
        a.forEach(v => { const o = el('option'); o.value = o.textContent = v; input.appendChild(o); });
        input.onchange = () => setOpt(key, input.value);
      } else if (type === 'bool') {
        input = el('input'); input.type = 'checkbox'; input.style.width = 'auto';
        input.onchange = () => setOpt(key, input.checked);
      } else if (type === 'range') {
        input = el('input'); input.type = 'range'; input.min = a; input.max = b;
        out = el('output'); out.style.marginLeft = '6px'; out.style.color = '#aeb8be';
        input.oninput = () => { out.textContent = input.value; setOpt(key, Number(input.value), true); };
        input.onchange = () => setOpt(key, Number(input.value));
      } else if (type === 'color') {
        input = el('input'); input.type = 'color';
      } else {
        input = el('input'); input.type = 'text'; input.maxLength = 4;
        input.onchange = () => setOpt(key, input.value);
      }
      if (type === 'bool') { lab.appendChild(input); lab.append(' ' + label); }
      else { lab.textContent = label; if (out) lab.appendChild(out); }
      wrap.appendChild(lab);
      if (type !== 'bool') wrap.appendChild(input);
      root.appendChild(wrap);
      host.appendChild(root);
      if (type === 'color') {
        enableAlpha(input);
        input.addEventListener('input', () => later(key, input.value));
      }
      inputs[key] = { input, out, type };
    });
    host.appendChild(root);
    return { root, inputs };
  }

  function refresh() {
    const row = $('ed-music-row');
    if (!row) return;
    const w = curWin();
    row.style.display = w ? '' : 'none';
    Object.values(groups).forEach(g => { g.root.style.display = 'none'; });
    if (!w) return;
    if (!groups[w.panel]) groups[w.panel] = build(w.panel, row);
    const g = groups[w.panel];
    g.root.style.display = '';
    const o = Object.assign({}, SCHEMAS[w.panel].defaults(), w.opts || {});
    Object.entries(g.inputs).forEach(([key, { input, out, type }]) => {
      if (type === 'bool') input.checked = !!o[key];
      else input.value = o[key] ?? '';
      if (out) out.textContent = input.value;
    });
  }

  const old = window.refreshWinEditor;
  window.refreshWinEditor = () => { old(); refresh(); };
})();