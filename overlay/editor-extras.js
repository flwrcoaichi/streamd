// editor-extras.js — theme defaults, per-window overrides, layers panel.
// theme is stored as a pseudo-layout named "__theme" so it persists/syncs with no backend change.
const EditorExtras = (() => {
  const $ = id => document.getElementById(id);
  const OVR = ['text_color', 'bg_color', 'border_mode', 'border_color', 'box_style', 'border_stops', 'text_color_stops', 'bg_color_stops'];
  const DEFAULTS = { text_color: '#d8dee2', bg_color: '#0a0c0d' };
  const PRESETS = {
    highlight: () => ({ border_mode: 'box', box_style: 'double', border_color: '#ffb238', text_color: '#ffb238' }),
    inverted: th => ({ bg_color: th.text_color || DEFAULTS.text_color, text_color: th.bg_color || DEFAULTS.bg_color }),
  };
  const CSS = `
.ee-title{margin:14px 0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8b969e}
.ee-ovr{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #252c31;font-size:10px;color:#77828a}
.ee-chip{width:auto !important;margin:0 !important;min-height:22px !important;padding:1px 7px !important;font-size:10px !important;border-color:#6b4d1a !important;color:#ffc366 !important}
.ee-chip:hover{border-color:var(--red) !important;color:var(--red) !important}
.ee-ovr select{width:auto;min-height:24px;font-size:10px;margin-left:auto}
.ee-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid #252c31;margin-bottom:3px;font-size:11px;cursor:pointer;background:#0b0e10}
.ee-row.sel{border-color:var(--amber);color:var(--amber)}
.ee-row.over{border-top:2px solid var(--amber)}
.ee-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ee-row .nm i{font-style:normal;color:#454c52}
.ee-row.off{opacity:.45}
.ee-btn{width:20px !important;min-height:20px !important;margin:0 !important;padding:0 !important;border:0 !important;background:transparent !important;font-size:12px !important}`;

  function init() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const rawUpdate = wm.updateWindow;
    // ── theme defaults (left rail → theme tab) ──
    const themePane = ($('bulk-border-stops') || {}).closest ? $('bulk-border-stops').closest('.ut-pane') || $('layout-controls') : $('layout-controls');
    const box = document.createElement('div');
    box.innerHTML = `
<div class="side-title">theme defaults</div>
<div class="hint">windows inherit these; anything set on a single window overrides them</div>
<div class="field"><label>text color</label><input type="color" id="th-text" value="#d8dee2"></div>
<div class="field"><label>background color</label><input type="color" id="th-bg" value="#0a0c0d"></div>
<div class="field"><label>border</label><select id="th-bmode"><option value="">default</option><option value="solid">solid</option><option value="pixel">pixel gradient</option><option value="box">box-drawing</option></select>
<select id="th-bbox" style="margin-top:6px"><option value="single">single</option><option value="rounded">rounded</option><option value="double">double</option><option value="heavy">heavy</option></select></div>
<div class="field"><label>border color</label><input type="color" id="th-bcolor" value="#ffffff"></div>
<button id="th-clear" type="button">clear theme</button>`;
    themePane.insertBefore(box, themePane.firstChild);
    const th = { text: $('th-text'), bg: $('th-bg'), bmode: $('th-bmode'), bbox: $('th-bbox'), bcolor: $('th-bcolor') };
    [th.text, th.bg, th.bcolor].forEach(i => enableAlpha(i));
    let timer = null;
    const collect = () => {
      const t = {};
      if (th.text.value.toLowerCase() !== DEFAULTS.text_color) t.text_color = th.text.value;
      if (th.bg.value.toLowerCase() !== DEFAULTS.bg_color) t.bg_color = th.bg.value;
      if (th.bmode.value) { t.border_mode = th.bmode.value; t.border_color = th.bcolor.value; }
      if (th.bmode.value === 'box') t.box_style = th.bbox.value;
      return t;
    };
    const commit = () => {
      const t = collect();
      wm.setTheme(t);
      clearTimeout(timer);
      timer = setTimeout(() => send({ cmd: 'wm_layout_set', name: '__theme', layout: [t] }), 200);
      refreshWinEditor();
    };
    Object.values(th).forEach(i => { i.addEventListener('input', commit); i.addEventListener('change', commit); });
    $('th-clear').onclick = () => {
      th.text.value = DEFAULTS.text_color; th.bg.value = DEFAULTS.bg_color; th.bmode.value = '';
      commit();
    };
    const themeFrom = layout => {
      const t = (Array.isArray(layout) && layout[0]) || {};
      wm.setTheme(t);
      th.text.value = t.text_color || DEFAULTS.text_color;
      th.bg.value = t.bg_color || DEFAULTS.bg_color;
      th.bmode.value = t.border_mode || '';
      th.bbox.value = t.box_style || 'single';
      th.bcolor.value = t.border_color || '#ffffff';
    };
    const handle = window.handleMessage;
    window.handleMessage = msg => {
      if (msg.type === 'init') themeFrom(((msg.state || {}).wm_layouts || {}).__theme);
      else if (msg.type === 'wm_layout' && msg.name === '__theme') themeFrom(msg.layout);
      return handle(msg);
    };

    // ── override chips + presets (top of the inspector) ──
    const inspBody = document.querySelector('#win-editor .ut-body') || $('win-editor');
    const strip = document.createElement('div');
    strip.className = 'ee-ovr';
    inspBody.insertBefore(strip, inspBody.firstChild);
    const label = document.createElement('span');
    label.textContent = 'overrides:';
    const chips = document.createElement('span');
    const stylePicker = document.createElement('select');
    stylePicker.innerHTML = '<option value="">style…</option>' + Object.keys(PRESETS).map(n => `<option>${n}</option>`).join('');
    strip.append(label, chips, stylePicker);
    const renderChips = () => {
      const w = selectedWinId && wm.getWindow(selectedWinId);
      chips.replaceChildren();
      stylePicker.disabled = !w;
      if (!w) return;
      const set = OVR.filter(k => w.opts && k in w.opts);
      if (!set.length) chips.textContent = 'none (inherits theme)';
      set.forEach(k => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ee-chip'; b.textContent = k.replace(/_/g, ' ') + ' ✕';
        b.title = 'click to inherit from the theme again';
        b.onclick = () => {
          const opts = { ...w.opts }; delete opts[k];
          rawUpdate(w.id, { opts });
          refreshWinEditor();
        };
        chips.appendChild(b);
      });
    };
    stylePicker.onchange = () => {
      const w = selectedWinId && wm.getWindow(selectedWinId);
      if (!w || !stylePicker.value) return;
      rawUpdate(w.id, { opts: { ...(w.opts || {}), ...PRESETS[stylePicker.value](wm.getTheme()) } });
      stylePicker.value = '';
      refreshWinEditor();
    };
    window.refreshOverrideChips = renderChips;
    const oldEditor = window.refreshWinEditor;
    window.refreshWinEditor = () => { oldEditor(); renderChips(); };

    // ── layers (left rail → list tab) ──
    const list = $('win-list');
    const layers = document.createElement('div');
    list.parentNode.insertBefore(layers, list);
    list.style.display = 'none';
    let dragId = null;
    const ordered = () => wm.getLayout().sort((a, b) => (b.z || 0) - (a.z || 0));
    const reorder = (from, to) => {
      if (from === to) return;
      const ids = ordered().map(w => w.id);
      ids.splice(ids.indexOf(from), 1);
      ids.splice(ids.indexOf(to), 0, from);
      ids.forEach((id, i) => rawUpdate(id, { z: ids.length - i }, { silent: true }));
      rawUpdate(from, {});
      renderLayers();
    };
    const iconBtn = (txt, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ee-btn'; b.textContent = txt; b.title = title;
      b.onclick = e => { e.stopPropagation(); fn(); };
      return b;
    };
    function renderLayers() {
      layers.innerHTML = '';
      ordered().forEach(w => {
        const row = document.createElement('div');
        const locked = !!(w.opts && w.opts.locked);
        row.className = 'ee-row' + (w.id === wm.getSelected() ? ' sel' : '') + (w.visible === false ? ' off' : '');
        row.draggable = true;
        row.ondragstart = e => { dragId = w.id; e.dataTransfer.effectAllowed = 'move'; };
        row.ondragover = e => { e.preventDefault(); row.classList.add('over'); };
        row.ondragleave = () => row.classList.remove('over');
        row.ondrop = e => { e.preventDefault(); reorder(dragId, w.id); };
        row.onclick = () => { wm.select(w.id); renderLayers(); };
        row.appendChild(iconBtn(w.visible === false ? '○' : '●', 'show / hide', () => { rawUpdate(w.id, { visible: w.visible === false }); renderLayers(); }));
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.innerHTML = `${w.title.replace(/</g, '&lt;')} <i>[${w.panel}]</i>`;
        row.appendChild(nm);
        row.appendChild(iconBtn(locked ? '■' : '□', 'lock (cannot be selected, moved or resized on the canvas)', () => {
          rawUpdate(w.id, { opts: { ...(w.opts || {}), locked: !locked } }); renderLayers();
        }));
        layers.appendChild(row);
      });
    }
    const oldList = window.refreshWinList;
    window.refreshWinList = () => { oldList(); renderLayers(); };
    renderLayers();
    renderChips();
  }
  return { init };
})();
EditorExtras.init();
