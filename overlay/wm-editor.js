// wm-editor.js — editor-only tools for control.html's layout view.
// selection handles live on their own layer above every window, so a window
// buried under another can still be moved/resized. selecting never reorders z.
const WMEditor = (() => {
  const CSS = `
#wm-tools{position:absolute;left:10px;top:10px;display:flex;flex-direction:column;gap:4px;z-index:5;background:#111518;border:1px solid #30383e;padding:4px}
#wm-tools button{width:28px;height:28px;margin:0;padding:0;font-size:14px;line-height:1;background:#191e22;border:1px solid #30383e;color:var(--text);border-radius:0}
#wm-tools button.on{border-color:var(--amber);color:var(--amber)}
#wm-tools button:disabled{opacity:.35;cursor:default}
#wm-tools hr{width:100%;border:0;border-top:1px solid #30383e;margin:1px 0}
#wm-pick{display:none;width:28px;height:20px;line-height:20px;text-align:center;font:700 11px var(--mono);border:1px solid #30383e}
#wm-sel{position:absolute;display:none;pointer-events:none;border:1px dashed #ffb238;box-sizing:border-box;z-index:1000000;--u:1}
#wm-sel i{position:absolute;pointer-events:auto;background:#ffb238;width:calc(9px*var(--u));height:calc(9px*var(--u));margin:calc(-4.5px*var(--u))}
#wm-sel b{position:absolute;pointer-events:auto;cursor:move;background:#ffb238;color:#0a0c0d;text-align:center;font-weight:400;
  left:calc(4px*var(--u));top:calc(4px*var(--u));width:calc(18px*var(--u));height:calc(18px*var(--u));line-height:calc(18px*var(--u));font-size:calc(13px*var(--u))}
.wm-delete-mode .wm-win{cursor:not-allowed}
.wm-delete-mode .wm-win:hover{outline:1px solid #ff3b3b;outline-offset:1px}
.wm-pick-mode .wm-win{cursor:crosshair}
.wm-pick-mode .wm-win:hover{outline:1px solid #5eb1ef;outline-offset:1px}`;

  const HANDLES = {
    nw: [0, 0, 'nwse-resize'], n: [50, 0, 'ns-resize'], ne: [100, 0, 'nesw-resize'], e: [100, 50, 'ew-resize'],
    se: [100, 100, 'nwse-resize'], s: [50, 100, 'ns-resize'], sw: [0, 100, 'nesw-resize'], w: [0, 50, 'ew-resize'],
  };
  const STYLE_KEYS = ['text_color', 'bg_color', 'text_color_stops', 'bg_color_stops', 'border_mode', 'border_color', 'border_color2',
    'border_stops', 'border_cell', 'border_speed', 'box_style', 'font_size', 'font_family', 'title_color', 'title_color_stops'];
  const ANCHORS = [['top left', 0, 0], ['top', 1, 0], ['top right', 2, 0], ['left', 0, 1], ['center', 1, 1],
    ['right', 2, 1], ['bottom left', 0, 2], ['bottom', 1, 2], ['bottom right', 2, 2]];
  const $ = id => document.getElementById(id);

  function attach(wm, o) {
    o = o || {};
    const inner = o.inner || $('layout-stage-inner');
    const wrap = o.stageWrap || $('layout-stage-wrap');
    const onCommit = o.onCommit || (() => {});
    const onRefresh = o.onRefresh || (() => {});
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const scale = () => (inner.getBoundingClientRect().width / inner.offsetWidth) || 1;
    const stageW = () => inner.offsetWidth || 1440, stageH = () => inner.offsetHeight || 1080;
    const grid = () => Math.max(1, wm.currentGrid());
    const sn = v => { const g = grid(); return g > 1 ? Math.round(v / g) * g : Math.round(v); };
    const stackAt = (x, y) => document.elementsFromPoint(x, y)
      .filter(el => el.classList && el.classList.contains('wm-win')).map(el => el.dataset.id);
    const pointAt = e => { const r = inner.getBoundingClientRect(), k = scale(); return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
    const ordered = () => wm.getLayout().sort((a, b) => (b.z || 0) - (a.z || 0));

    // geometry fields follow the window without touching the other inspector fields
    const syncGeom = () => {
      const w = wm.getWindow(wm.getSelected());
      if (!w) return;
      ['x', 'y', 'w', 'h'].forEach(k => { const el = $('ed-' + k); if (el && document.activeElement !== el) el.value = w[k]; });
    };
    const commit = full => { onCommit(); if (full) onRefresh(); else syncGeom(); };

    // ── actions ──
    function layer(id, mode) {
      const ids = ordered().map(w => w.id), i = ids.indexOf(id);
      if (i < 0) return;
      ids.splice(i, 1);
      ids.splice(mode === 'up' ? Math.max(0, i - 1) : mode === 'down' ? Math.min(ids.length, i + 1) : mode === 'front' ? 0 : ids.length, 0, id);
      ids.forEach((k, n) => wm.updateWindow(k, { z: ids.length - n }, { silent: true }));
      wm.updateWindow(id, {});
      commit(false);
    }
    function dup(id) {
      const w = wm.getWindow(id);
      if (!w || typeof nextIdFor !== 'function') return;
      const nid = nextIdFor(w.panel), off = grid() > 1 ? grid() : 10;
      wm.addWindow({ ...JSON.parse(JSON.stringify(w)), id: nid, x: w.x + off, y: w.y + off });
      wm.select(nid);
      commit(true);
    }
    function center(id, axis) {
      const w = wm.getWindow(id);
      if (!w) return;
      wm.updateWindow(id, axis === 'x' ? { x: Math.round((stageW() - w.w) / 2) } : { y: Math.round((stageH() - w.h) / 2) });
      commit(false);
    }
    function setOpts(id, p) {
      const w = wm.getWindow(id);
      if (w) { wm.updateWindow(id, { opts: { ...(w.opts || {}), ...p } }); commit(true); }
    }
    let picked = null;
    const sample = w => { const s = {}; STYLE_KEYS.forEach(k => { if (w.opts && k in w.opts) s[k] = JSON.parse(JSON.stringify(w.opts[k])); }); return s; };
    function paste(id) {
      const w = wm.getWindow(id);
      if (!w || !picked) return;
      const opts = { ...(w.opts || {}) };
      STYLE_KEYS.forEach(k => { if (k in picked) opts[k] = JSON.parse(JSON.stringify(picked[k])); else delete opts[k]; });
      wm.updateWindow(id, { opts });
      commit(true);
    }
    function addAt(type, where) {
      const sel = $('add-panel-type'), btn = $('btn-add-window');
      if (!sel || !btn) return;
      sel.value = type;
      btn.onclick();
      const id = wm.getSelected(), w = wm.getWindow(id);
      if (!w) return;
      let x, y;
      if (Array.isArray(where)) {
        const m = 20, [c, r] = where;
        x = c === 0 ? m : c === 1 ? Math.round((stageW() - w.w) / 2) : stageW() - w.w - m;
        y = r === 0 ? m : r === 1 ? Math.round((stageH() - w.h) / 2) : stageH() - w.h - m;
      } else { x = sn(where.x); y = sn(where.y); }
      wm.updateWindow(id, { x, y });
      commit(true);
    }
    const addItems = () => Array.from(($('add-panel-type') || { options: [] }).options).map(op => ({
      label: op.textContent,
      submenu: [{ label: 'click to place…', action: () => { pending = op.value; setTool('add'); } }, '-',
        ...ANCHORS.map(([n, c, r]) => ({ label: n, action: () => addAt(op.value, [c, r]) }))],
    }));

    // ── tool strip ──
    let tool = 'select', pending = null;
    const bar = document.createElement('div');
    bar.id = 'wm-tools';
    const btns = {};
    const mk = (id, label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title; b.onclick = fn;
      bar.appendChild(b); btns[id] = b;
    };
    const rule = () => bar.appendChild(document.createElement('hr'));
    const swatch = document.createElement('div');
    swatch.id = 'wm-pick';
    swatch.textContent = 'Aa';
    const updateSwatch = () => {
      swatch.style.display = picked ? 'block' : 'none';
      if (!picked) return;
      swatch.style.background = picked.bg_color || wm.getTheme().bg_color || '#0a0c0d';
      swatch.style.color = picked.text_color || wm.getTheme().text_color || '#d8dee2';
    };
    const setTool = t => {
      tool = t;
      inner.classList.toggle('wm-delete-mode', t === 'delete');
      inner.classList.toggle('wm-pick-mode', t === 'pick' || t === 'add');
      ['select', 'add', 'pick', 'delete'].forEach(k => btns[k].classList.toggle('on', k === t));
    };
    mk('select', '▸', 'select / move (V) — alt+click cycles windows underneath', () => setTool('select'));
    mk('add', '+', 'add window… (choose a spot or click to place)', () => {
      const r = btns.add.getBoundingClientRect();
      ContextMenu.show(r.right + 4, r.top, addItems());
    });
    mk('dup', '⧉', 'duplicate selected (ctrl+d)', () => dup(wm.getSelected()));
    mk('pick', '✐', 'style picker (I) — click a window to sample its style, click others to paste, shift+click re-samples, esc stops', () => {
      setTool('pick');
    });
    mk('delete', '✕', 'delete tool (X) — click a window to remove it', () => setTool('delete'));
    rule();
    mk('undo', '↶', 'undo (ctrl+z)', () => { wm.undo(); commit(true); });
    mk('redo', '↷', 'redo (ctrl+shift+z)', () => { wm.redo(); commit(true); });
    bar.appendChild(swatch);
    wrap.appendChild(bar);
    setTool('select');

    // ── selection layer ──
    const sel = document.createElement('div');
    sel.id = 'wm-sel';
    const grip = document.createElement('b');
    grip.textContent = '✥'; grip.title = 'drag to move';
    sel.appendChild(grip);
    Object.entries(HANDLES).forEach(([name, [l, t, cur]]) => {
      const h = document.createElement('i');
      h.style.left = l + '%'; h.style.top = t + '%'; h.style.cursor = cur;
      h.addEventListener('mousedown', e => begin(e, name));
      sel.appendChild(h);
    });
    grip.addEventListener('mousedown', e => begin(e, 'move'));
    inner.appendChild(sel);

    let drag = null;
    function begin(e, mode) {
      if (e.button !== 0) return;
      const id = wm.getSelected();
      const w = id && wm.getWindow(id);
      if (!w || (w.opts && w.opts.locked)) return;
      e.preventDefault(); e.stopPropagation();
      drag = { mode, id, sx: e.clientX, sy: e.clientY, x: w.x, y: w.y, w: w.w, h: w.h };
    }
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      const k = scale();
      const dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
      const m = drag.mode;
      let { x, y, w, h } = drag;
      if (m === 'move') { x = sn(x + dx); y = sn(y + dy); }
      else {
        if (m.includes('e')) w = sn(w + dx);
        if (m.includes('s')) h = sn(h + dy);
        if (m.includes('w')) { const nx = sn(x + dx); w += x - nx; x = nx; }
        if (m.includes('n')) { const ny = sn(y + dy); h += y - ny; y = ny; }
      }
      w = Math.max(80, w); h = Math.max(60, h);
      if (m !== 'move' && wm.snapSize) { w = wm.snapSize(drag.id, 'w', w); h = wm.snapSize(drag.id, 'h', h); }
      wm.updateWindow(drag.id, { x, y, w, h }, { silent: true });
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const id = drag.id; drag = null;
      const w = wm.getWindow(id);
      if (w) wm.updateWindow(id, { x: w.x, y: w.y, w: w.w, h: w.h }); // one emit = one undo step
      commit(false);
    });

    // tools + alt-click cycling, captured before a window's own handlers run
    inner.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('#wm-sel')) return;
      if (tool === 'add' && pending) {
        e.preventDefault(); e.stopPropagation();
        const type = pending; pending = null; setTool('select');
        addAt(type, pointAt(e));
        return;
      }
      if (tool === 'select' && !e.altKey) return;
      const stack = stackAt(e.clientX, e.clientY);
      if (!stack.length) return;
      e.preventDefault(); e.stopPropagation();
      if (tool === 'delete') { wm.removeWindow(stack[0]); commit(true); return; }
      if (tool === 'pick') {
        if (!picked || e.shiftKey) { picked = sample(wm.getWindow(stack[0])); updateSwatch(); } else paste(stack[0]);
        return;
      }
      const i = stack.indexOf(wm.getSelected());
      wm.select(stack[(i + 1) % stack.length]);
    }, true);

    // ── context menu ──
    inner.addEventListener('contextmenu', e => {
      e.preventDefault();
      const stack = e.target.closest('#wm-sel') ? [wm.getSelected()].filter(Boolean) : stackAt(e.clientX, e.clientY);
      if (!stack.length) {
        const pt = pointAt(e);
        ContextMenu.show(e.clientX, e.clientY, [{ label: 'add window here', submenu: Array.from(($('add-panel-type') || { options: [] }).options)
          .map(op => ({ label: op.textContent, action: () => addAt(op.value, pt) })) }]);
        return;
      }
      const id = stack[0];
      wm.select(id);
      const w = wm.getWindow(id), locked = !!(w.opts && w.opts.locked);
      const items = [
        { label: 'duplicate', hint: 'ctrl+d', action: () => dup(id) }, '-',
        { label: 'center horizontally', action: () => center(id, 'x') },
        { label: 'center vertically', action: () => center(id, 'y') }, '-',
        { label: 'bring forward', action: () => layer(id, 'up') }, { label: 'send backward', action: () => layer(id, 'down') },
        { label: 'bring to front', action: () => layer(id, 'front') }, { label: 'send to back', action: () => layer(id, 'back') }, '-',
        { label: locked ? 'unlock' : 'lock', action: () => setOpts(id, { locked: !locked }) },
        { label: w.visible === false ? 'show' : 'hide', action: () => { wm.updateWindow(id, { visible: w.visible === false }); commit(true); } }, '-',
        { label: 'copy style', action: () => { picked = sample(w); updateSwatch(); } },
        { label: 'paste style', disabled: !picked, action: () => paste(id) }, '-',
        { label: 'delete', hint: 'del', action: () => { wm.removeWindow(id); commit(true); } },
      ];
      if (stack.length > 1) items.push('-', { label: 'select below', submenu: stack.slice(1).map(sid => ({ label: wm.getWindow(sid).title, action: () => wm.select(sid) })) });
      ContextMenu.show(e.clientX, e.clientY, items);
    }, true);

    // ── typed geometry applies immediately (no apply button, no reset) ──
    ['x', 'y', 'w', 'h'].forEach(k => {
      const el = $('ed-' + k);
      if (!el) return;
      el.addEventListener('change', () => {
        const id = wm.getSelected(), w = id && wm.getWindow(id);
        if (!w) return;
        const val = key => { const n = parseInt($('ed-' + key).value, 10); return Number.isFinite(n) ? n : w[key]; };
        wm.updateWindow(id, { x: val('x'), y: val('y'), w: val('w'), h: val('h') });
        commit(false);
      });
    });

    // ── keyboard ──
    window.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const view = $('view-layout');
      if (!view || !view.classList.contains('active')) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) wm.redo(); else wm.undo();
        commit(true);
      } else if (mod && k === 'd') { e.preventDefault(); dup(wm.getSelected()); }
      else if (mod) return;
      else if (k === 'v' || k === 'escape') { picked = k === 'escape' ? null : picked; updateSwatch(); pending = null; setTool('select'); }
      else if (k === 'x') setTool('delete');
      else if (k === 'i') setTool('pick');
      else if (k === 'delete' || k === 'backspace') {
        const id = wm.getSelected();
        if (id && wm.getWindow(id)) { e.preventDefault(); wm.removeWindow(id); commit(true); }
      } else if (k.startsWith('arrow')) {
        const id = wm.getSelected(), w = id && wm.getWindow(id);
        if (!w || (w.opts && w.opts.locked)) return;
        e.preventDefault();
        const step = grid() * (e.shiftKey ? 4 : 1);
        wm.updateWindow(id, {
          x: w.x + (k === 'arrowright' ? step : k === 'arrowleft' ? -step : 0),
          y: w.y + (k === 'arrowdown' ? step : k === 'arrowup' ? -step : 0),
        });
        commit(false);
      }
    });

    // ── keep the selection box glued to its window ──
    (function place() {
      const id = wm.getSelected();
      const w = id && wm.getWindow(id);
      if (!w) sel.style.display = 'none';
      else {
        sel.style.display = 'block';
        sel.style.left = w.x + 'px'; sel.style.top = w.y + 'px';
        sel.style.width = w.w + 'px'; sel.style.height = w.h + 'px';
        sel.style.setProperty('--u', String(1 / scale()));
      }
      btns.undo.disabled = !wm.canUndo();
      btns.redo.disabled = !wm.canRedo();
      requestAnimationFrame(place);
    })();

    return { setTool };
  }

  return { attach };
})();
