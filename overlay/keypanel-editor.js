// keypanel-editor.js — replaces the key panel inspector row (textarea + select-and-sync fields).
// the preview is the REAL overlay renderer, fields commit on change/enter and never rewrite a field you're typing in.
window.KeyPanelEditor = (() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
  const CSS = `
#ed-key-panel-row > *:not(#kp-editor){display:none !important}
#kp-editor{margin-top:6px}
.kp-bar{display:flex;flex-wrap:wrap;gap:3px;align-items:center;margin-bottom:6px}
.kp-bar button{width:26px !important;min-height:26px !important;margin:0 !important;padding:0 !important;font-size:13px !important}
.kp-bar input[type=text]{width:46px;min-height:26px;padding:2px 4px}
.kp-bar select{width:auto;min-height:26px;font-size:10px;margin-left:auto}
.kp-sp{width:6px}
.kp-stage{position:relative;border:1px solid #30383e;background:#07090a;overflow:hidden;outline:0}
.kp-stage:focus{border-color:#6b4d1a}
.kp-real{position:absolute;left:0;top:0;background:#0a0c0d;background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:10px 10px;background-position:10px 10px}
.kp-hit{position:absolute;box-sizing:border-box;cursor:move;border:1px dashed transparent}
.kp-hit:hover{border-color:#5eb1ef}
.kp-hit.on{border-color:#ffb238}
.kp-sec{margin:10px 0 5px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8b969e}
.kp-sec span{color:#454c52;text-transform:none;letter-spacing:0}
.kp-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.kp-grid label{display:block;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#77828a;margin-bottom:2px}
.kp-grid .wide{grid-column:1/-1}
.kp-grid input[type=text],.kp-grid select{min-height:28px}`;

  const KEYF = { 'kp-key': ['key', 'text'], 'kp-label': ['label', 'text'], 'kp-shape': ['shape', 'select'], 'kp-color': ['color', 'color'],
    'kp-x': ['x', 'pos'], 'kp-y': ['y', 'pos'], 'kp-w': ['w', 'dim'], 'kp-h': ['h', 'dim'] };
  const PANELF = { 'kp-size': ['size', 'dim'], 'kp-gap': ['gap', 'pos'], 'kp-pshape': ['shape', 'select'], 'kp-active': ['active_color', 'color'],
    'kp-inactive': ['inactive_color', 'color'], 'kp-radius': ['corner_radius', 'radius'], 'kp-border': ['border', 'bool'],
    'kp-bw': ['border_width', 'pos'], 'kp-bc': ['border_color', 'color'] };
  const SHAPES = '<option>round</option><option>square</option><option>pill</option><option>diamond</option>';

  const ui = {};
  let sel = 0, snapStep = 10, timer = null;
  const curWin = () => {
    let id = null;
    try { id = selectedWinId; } catch (e) { /* not ready */ }
    const w = id && wm.getWindow(id);
    return w && w.panel === 'key_panel' ? w : null;
  };
  const keySize = o => num(o.size, 48);
  const keyGap = o => Math.max(2, num(o.gap, 8));
  const inner = w => {
    const b = wm.getBodyEl(w.id);
    return { W: Math.max(40, (b ? b.clientWidth : w.w) - 20), H: Math.max(40, (b ? b.clientHeight : w.h) - 20) };
  };
  const snap = v => Math.max(0, Math.round(v / snapStep) * snapStep);

  // positions exactly as the overlay lays them out (explicit x/y, else its centered row)
  function rects(w) {
    const o = w.opts || {}, keys = o.keys || [], size = keySize(o), gap = keyGap(o), { W, H } = inner(w);
    const fin = v => Number.isFinite(Number(v)) && v !== undefined && v !== null;
    const any = keys.some(k => fin(k.x) || fin(k.y));
    const start = (W - keys.length * (size + gap)) / 2 + gap / 2;
    return keys.map((k, i) => {
      const kw = num(k.w, size), kh = num(k.h, size);
      return {
        x: fin(k.x) ? Number(k.x) : Math.round(any ? i * (size + gap) : start + i * (size + gap)),
        y: fin(k.y) ? Number(k.y) : Math.round(any ? 0 : (H - kh) / 2), w: kw, h: kh,
      };
    });
  }

  function commit(fn, silent) {
    const w = curWin();
    if (!w) return;
    const rs = rects(w);
    const opts = { ...(w.opts || {}) };
    opts.keys = (opts.keys || []).map((k, i) => ({ ...k, x: rs[i].x, y: rs[i].y })); // materialize once, then edit
    fn(opts);
    wm.updateWindow(w.id, { opts }, silent ? { silent: true } : undefined);
    render();
  }

  // ── preview ──
  function renderPreview() {
    const w = curWin();
    if (!w) return;
    const { W, H } = inner(w), pw = W + 20, ph = H + 20;
    const avail = ui.stage.clientWidth || 260;
    ui.scale = Math.min(1, (avail - 2) / pw);
    ui.stage.style.height = Math.ceil(ph * ui.scale) + 2 + 'px';
    ui.stage.innerHTML = '';
    const real = el('div', 'kp-real wm-body key-panel-body');
    real.style.cssText = `width:${pw}px;height:${ph}px;transform:scale(${ui.scale});transform-origin:0 0`;
    ui.stage.appendChild(real);
    const h = Panels.key_panel.mount(real, w);
    Panels.key_panel.applyOpts(h, w);
    const keys = (w.opts && w.opts.keys) || [];
    rects(w).forEach((r, i) => {
      const b = el('div', 'kp-hit' + (i === sel ? ' on' : ''));
      const rot = ((num(keys[i].rotate, 0) % 360) + 360) % 360;
      b.style.cssText = `left:${10 + r.x}px;top:${10 + r.y}px;width:${r.w}px;height:${r.h}px;` + (rot ? `transform:rotate(${rot}deg)` : '');
      b.addEventListener('pointerdown', e => down(e, i));
      b.addEventListener('contextmenu', e => keyMenu(e, i));
      real.appendChild(b);
    });
    real.addEventListener('contextmenu', e => {
      if (e.target !== real && !e.target.closest('.key-panel-row')) return;
      e.preventDefault();
      const r = real.getBoundingClientRect(), p = { x: (e.clientX - r.left) / ui.scale - 10, y: (e.clientY - r.top) / ui.scale - 10 };
      ContextMenu.show(e.clientX, e.clientY, [{ label: `add key "${ui.add.value.trim() || 'w'}" here`, action: () => addKey(p) }]);
    });
  }

  function down(e, i) {
    if (e.button !== 0) return;
    e.preventDefault();
    ui.stage.focus();
    sel = i;
    ui.stage.querySelectorAll('.kp-hit').forEach((b, j) => b.classList.toggle('on', j === i));
    fill();
    const w = curWin();
    if (!w) return;
    const r0 = rects(w)[i], sx = e.clientX, sy = e.clientY, s = ui.scale || 1;
    let moved = false;
    const move = ev => {
      moved = true;
      const dx = (ev.clientX - sx) / s, dy = (ev.clientY - sy) / s;
      commit(o => { o.keys[i].x = snap(r0.x + dx); o.keys[i].y = snap(r0.y + dy); }, true);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) commit(() => {}); // single undo step
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── actions ──
  const rotate = d => commit(o => { const k = o.keys[sel]; if (k) k.rotate = (((num(k.rotate, 0) + d) % 360) + 360) % 360; });
  const centerKey = axis => commit(o => {
    const k = o.keys[sel], w = curWin();
    if (!k || !w) return;
    const { W, H } = inner(w), size = keySize(o);
    if (axis === 'x') k.x = Math.round((W - num(k.w, size)) / 2); else k.y = Math.round((H - num(k.h, size)) / 2);
  });
  const layer = mode => commit(o => {
    const a = o.keys;
    if (!a[sel]) return;
    const j = mode === 'up' ? Math.min(a.length - 1, sel + 1) : mode === 'down' ? Math.max(0, sel - 1) : mode === 'front' ? a.length - 1 : 0;
    const [k] = a.splice(sel, 1);
    a.splice(j, 0, k);
    sel = j;
  });
  const dupKey = () => commit(o => {
    const k = o.keys[sel];
    if (!k) return;
    o.keys.push({ ...k, x: num(k.x, 0) + 10, y: num(k.y, 0) + 10 });
    sel = o.keys.length - 1;
  });
  const delKey = () => commit(o => { if (o.keys[sel]) { o.keys.splice(sel, 1); sel = Math.max(0, sel - 1); } });
  function addKey(at) {
    const name = (ui.add.value || '').trim().toLowerCase();
    if (!name) return;
    commit(o => {
      const w = curWin(), { W, H } = inner(w), size = keySize(o);
      o.keys.push({ key: name, label: name === 'space' ? 'SPACE' : name.toUpperCase(), shape: o.shape || 'round', color: o.active_color || '#7ef7c6',
        x: snap(at ? at.x : (W - size) / 2), y: snap(at ? at.y : (H - size) / 2) });
      sel = o.keys.length - 1;
    });
  }
  function keyMenu(e, i) {
    e.preventDefault(); e.stopPropagation();
    sel = i; render();
    ContextMenu.show(e.clientX, e.clientY, [
      { label: 'rotate 90° clockwise', hint: 'r', action: () => rotate(90) },
      { label: 'rotate 90° counter-clockwise', action: () => rotate(-90) }, '-',
      { label: 'center horizontally', action: () => centerKey('x') },
      { label: 'center vertically', action: () => centerKey('y') }, '-',
      { label: 'move up a layer', action: () => layer('up') }, { label: 'move down a layer', action: () => layer('down') },
      { label: 'bring to front', action: () => layer('front') }, { label: 'send to back', action: () => layer('back') }, '-',
      { label: 'duplicate', hint: 'ctrl+d', action: dupKey }, { label: 'delete', hint: 'del', action: delKey },
    ]);
  }

  // ── fields (commit on change; the focused field is never rewritten) ──
  function onField(id, el_, table, target) {
    const [prop, type] = table[id];
    if (type === 'color') { clearTimeout(timer); timer = setTimeout(() => apply(), 250); } else apply();
    function apply() {
      const v = el_.type === 'checkbox' ? el_.checked : el_.value;
      commit(o => {
        const t = target(o);
        if (!t) return;
        if (type === 'text') {
          const s = String(v).trim();
          if (prop === 'key') {
            if (!s) return;
            const old = String(t.key || '').toLowerCase();
            if (!t.label || String(t.label).toLowerCase() === old) t.label = s === 'space' ? 'SPACE' : s.toUpperCase();
            t.key = s.toLowerCase();
          } else if (s) t.label = s; else delete t.label;
        } else if (type === 'pos') { const n = parseInt(v, 10); if (Number.isFinite(n)) t[prop] = Math.max(0, n); }
        else if (type === 'dim') { const n = parseInt(v, 10); if (v === '' && prop !== 'size') delete t[prop]; else if (Number.isFinite(n) && n >= 8) t[prop] = n; }
        else if (type === 'radius') { const n = parseInt(v, 10); if (Number.isFinite(n)) t[prop] = Math.max(0, n); else delete t[prop]; }
        else t[prop] = v;
      });
    }
  }
  const editing = () => { const a = document.activeElement; return ui.root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName); };
  function fill() {
    const w = curWin();
    if (!w || editing()) return;
    const o = w.opts || {}, keys = o.keys || [], k = keys[sel], r = rects(w)[sel];
    const set = (id, v) => { const e = $(id); if (!e) return; if (e.type === 'checkbox') e.checked = !!v; else e.value = v === undefined || v === null ? '' : v; };
    ui.info.textContent = keys.length ? `${sel + 1}/${keys.length}${k && k.rotate ? ' · ' + k.rotate + '°' : ''}` : 'none';
    if (k) {
      set('kp-key', k.key); set('kp-label', k.label || ''); set('kp-shape', k.shape || o.shape || 'round'); set('kp-color', k.color || o.active_color || '#7ef7c6');
      set('kp-x', r.x); set('kp-y', r.y); set('kp-w', k.w || ''); set('kp-h', k.h || '');
    }
    set('kp-size', keySize(o)); set('kp-gap', num(o.gap, 8)); set('kp-pshape', o.shape || 'round');
    set('kp-active', o.active_color || '#7ef7c6'); set('kp-inactive', o.inactive_color || '#1f2731');
    set('kp-radius', o.corner_radius === undefined || o.corner_radius === null ? '' : o.corner_radius);
    set('kp-border', o.border === true); set('kp-bw', num(o.border_width, 1)); set('kp-bc', o.border_color || '#ffffff');
  }

  function render() {
    const w = curWin();
    if (!w || !ui.root) return;
    sel = Math.min(sel, Math.max(0, ((w.opts && w.opts.keys) || []).length - 1));
    renderPreview();
    fill();
  }

  const F = (id, label, inner_, cls) => `<div class="${cls || ''}"><label>${label}</label>${inner_}</div>`;
  const T = id => `<input type="text" id="${id}" autocomplete="off" spellcheck="false">`;
  const C = id => `<input type="color" id="${id}" value="#7ef7c6">`;
  const S = id => `<select id="${id}">${SHAPES}</select>`;

  function build(row) {
    const root = el('div');
    root.id = 'kp-editor';
    root.innerHTML = `
<div class="kp-bar">
  <input id="kp-add" type="text" value="w" title="key to add (e.g. w, space, up, ctrl)">
  <button type="button" data-a="add" title="add key">+</button><button type="button" data-a="dup" title="duplicate (ctrl+d)">⧉</button>
  <button type="button" data-a="del" title="delete (del)">✕</button><span class="kp-sp"></span>
  <button type="button" data-a="ccw" title="rotate 90° counter-clockwise">⟲</button><button type="button" data-a="cw" title="rotate 90° clockwise (r)">⟳</button>
  <button type="button" data-a="ch" title="center horizontally">↔</button><button type="button" data-a="cv" title="center vertically">↕</button>
  <button type="button" data-a="up" title="move up a layer">▲</button><button type="button" data-a="down" title="move down a layer">▼</button>
  <select id="kp-snap" title="drag snap (px)"><option>1</option><option>5</option><option selected>10</option></select>
</div>
<div class="kp-stage" id="kp-stage" tabindex="0"></div>
<div class="kp-sec">selected key <span id="kp-info"></span></div>
<div class="kp-grid">
  ${F('', 'key', T('kp-key'))}${F('', 'label', T('kp-label'))}
  ${F('', 'shape', S('kp-shape'))}${F('', 'color', C('kp-color'))}
  ${F('', 'x', T('kp-x'))}${F('', 'y', T('kp-y'))}
  ${F('', 'width', T('kp-w'))}${F('', 'height', T('kp-h'))}
</div>
<div class="kp-sec">panel defaults <span>(text color is on the color tab)</span></div>
<div class="kp-grid">
  ${F('', 'key size', T('kp-size'))}${F('', 'gap', T('kp-gap'))}
  ${F('', 'shape', S('kp-pshape'))}${F('', 'corner radius', T('kp-radius'))}
  ${F('', 'active', C('kp-active'))}${F('', 'inactive', C('kp-inactive'))}
  ${F('', 'border', '<input type="checkbox" id="kp-border" style="width:auto">')}${F('', 'border width', T('kp-bw'))}
  ${F('', 'border color', C('kp-bc'), 'wide')}
</div>`;
    row.appendChild(root);
    ui.root = root; ui.stage = $('kp-stage'); ui.add = $('kp-add'); ui.info = $('kp-info');
    ['kp-color', 'kp-active', 'kp-inactive', 'kp-bc'].forEach(id => enableAlpha($(id)));
    Object.keys(KEYF).forEach(id => { const e = $(id); e.addEventListener(KEYF[id][1] === 'color' ? 'input' : 'change', () => onField(id, e, KEYF, o => o.keys[sel])); });
    Object.keys(PANELF).forEach(id => { const e = $(id); e.addEventListener(PANELF[id][1] === 'color' ? 'input' : 'change', () => onField(id, e, PANELF, o => o)); });
    $('kp-snap').addEventListener('change', e => { snapStep = parseInt(e.target.value, 10) || 10; });
    const acts = { add: () => addKey(), dup: dupKey, del: delKey, ccw: () => rotate(-90), cw: () => rotate(90),
      ch: () => centerKey('x'), cv: () => centerKey('y'), up: () => layer('up'), down: () => layer('down') };
    root.querySelectorAll('.kp-bar button').forEach(b => { b.onclick = () => acts[b.dataset.a](); });
    // keys handled here must not reach the layout editor's window shortcuts (delete would remove the window!)
    ui.stage.addEventListener('keydown', e => {
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey, step = snapStep * (e.shiftKey ? 4 : 1);
      const nudge = (dx, dy) => commit(o => { const t = o.keys[sel]; if (t) { t.x = Math.max(0, t.x + dx); t.y = Math.max(0, t.y + dy); } });
      let handled = true;
      if (mod && k === 'd') dupKey();
      else if (mod) handled = false;
      else if (k === 'delete' || k === 'backspace') delKey();
      else if (k === 'r') rotate(e.shiftKey ? -90 : 90);
      else if (k === 'arrowleft') nudge(-step, 0); else if (k === 'arrowright') nudge(step, 0);
      else if (k === 'arrowup') nudge(0, -step); else if (k === 'arrowdown') nudge(0, step);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    new ResizeObserver(() => { if (curWin() && ui.stage.clientWidth && Math.abs(ui.stage.clientWidth - (ui.lastW || 0)) > 1) { ui.lastW = ui.stage.clientWidth; renderPreview(); } }).observe(ui.stage);
  }

  function refresh() {
    const w = curWin(), row = $('ed-key-panel-row');
    if (!w || !row) return;
    if (!ui.root) build(row);
    if (w.id !== ui.winId) { ui.winId = w.id; sel = 0; }
    render();
  }
  const old = window.refreshWinEditor;
  window.refreshWinEditor = () => { old(); refresh(); };
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  return { render };
})();
