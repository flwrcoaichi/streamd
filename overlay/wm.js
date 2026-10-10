function createWM(opts) {
  const stageEl = opts.stageEl;
  const editable = !!opts.editable;
  const onLayoutChange = opts.onLayoutChange || (() => {});
  const renderBody = opts.renderBody || (() => {});
  const onSelect = opts.onSelect || (() => {});

  const GRID = opts.gridSize || 1;
  const MIN_W = 80, MIN_H = 60;

  let windows = new Map();
  let els = new Map();    
  let zCounter = 10;
  let selectedId = null;
  let suppressEmit = false;

  function setGridSize(px) {
    opts.gridSize = px;
  }
  function currentGrid() {
    return opts.gridSize || 1;
  }

  function snap(v) {
    const g = currentGrid();
    if (g <= 1) return Math.round(v);
    return Math.round(v / g) * g;
  }

  function clampToStage(win) {
    const sw = stageEl.clientWidth || 1440;
    const sh = stageEl.clientHeight || 1080;
    win.w = Math.max(MIN_W, Math.min(win.w, sw));
    win.h = Math.max(MIN_H, Math.min(win.h, sh));
    win.x = Math.max(0, Math.min(win.x, sw - 10));
    win.y = Math.max(0, Math.min(win.y, sh - 10));
  }

  let theme = {};
  const effOpts = win => Object.assign({}, theme, win.opts || {});
  function setTheme(t) {
    theme = t && typeof t === 'object' ? t : {};
    windows.forEach((w, id) => { const rec = els.get(id); if (rec) { applyGeometry(w, rec); applyWindowOpts(w, rec); } });
  }
  const past = [], future = [];
  let last = null, restoring = false;

  function emitLayoutChange() {
    if (suppressEmit) return;
    const snap = JSON.stringify(getLayout());
    if (snap !== last) {
      if (last !== null) { past.push(last); if (past.length > 100) past.shift(); }
      future.length = 0;
      last = snap;
    }
    onLayoutChange(getLayout());
  }

  function restore(snap) {
    restoring = true;
    setLayout(JSON.parse(snap), { silent: true });
    restoring = false;
    last = snap;
    onLayoutChange(getLayout());
  }
  function undo() { if (!past.length) return; future.push(last); restore(past.pop()); }
  function redo() { if (!future.length) return; past.push(last); restore(future.pop()); }

  function getLayout() {
    return Array.from(windows.values()).map(w => ({ ...w }));
  }

 
 
 
 
 
 
 
 
 
  function setLayout(layoutArr, opts2) {
    opts2 = opts2 || {};
    suppressEmit = !!opts2.silent;

    const nextList = (layoutArr || []).map(normalizeWindow);
    const nextIds = new Set(nextList.map(w => w.id));

   
    for (const id of Array.from(windows.keys())) {
      if (!nextIds.has(id)) {
        destroyWindowEl(id);
        windows.delete(id);
      }
    }

   
    for (const win of nextList) {
      const existing = windows.get(win.id);
      if (!existing) {
        windows.set(win.id, win);
        zCounter = Math.max(zCounter, (win.z || 0) + 1);
        renderWindow(win);
      } else {
       
       
       
        if (existing.panel !== win.panel) {
          destroyWindowEl(win.id);
          windows.set(win.id, win);
          zCounter = Math.max(zCounter, (win.z || 0) + 1);
          renderWindow(win);
          continue;
        }
        Object.assign(existing, win);
        const rec = els.get(win.id);
        if (rec) {
          applyGeometry(existing, rec);
          const title = rec.header.querySelector('.wm-title');
          if (title) title.textContent = existing.title;
          applyWindowOpts(existing, rec);
        }
      }
    }

    suppressEmit = false;
    if (!restoring) {
      // server echoes of our own layout match `last` and keep history intact
      const snap = JSON.stringify(getLayout());
      if (snap !== last) { past.length = 0; future.length = 0; last = snap; }
    }
  }

  function normalizeWindow(w) {
    return {
      id: w.id,
      panel: w.panel,
      title: w.title || w.panel || w.id,
      x: typeof w.x === 'number' ? w.x : 40,
      y: typeof w.y === 'number' ? w.y : 40,
      w: typeof w.w === 'number' ? w.w : 320,
      h: typeof w.h === 'number' ? w.h : 200,
      z: typeof w.z === 'number' ? w.z : 1,
      kind: w.kind || 'normal',
      visible: w.visible !== undefined ? !!w.visible : (w.kind !== 'popup'),
      opts: w.opts || {},
    };
  }

  function addWindow(w) {
    const win = normalizeWindow(w);
    win.z = zCounter++;
    windows.set(win.id, win);
    renderWindow(win);
    emitLayoutChange();
    return win;
  }

  function removeWindow(id) {
    windows.delete(id);
    destroyWindowEl(id);
    emitLayoutChange();
  }

  function updateWindow(id, patch, opts2) {
    const win = windows.get(id);
    if (!win) return;
    Object.assign(win, patch);
    clampToStage(win);
    const rec = els.get(id);
    if (rec) {
      applyGeometry(win, rec);
      applyWindowOpts(win, rec);
    }
    if (!(opts2 && opts2.silent)) emitLayoutChange();
  }

  function bringToFront(id) {
    const win = windows.get(id);
    if (!win) return;
    win.z = zCounter++;
    const rec = els.get(id);
    if (rec && win.kind !== 'topmost') rec.root.style.zIndex = String(win.z);
  }

  function select(id) {
    selectedId = id;
    els.forEach((rec, wid) => {
      rec.root.classList.toggle('wm-selected', wid === id);
    });
    onSelect(id);
  }

  function destroyWindowEl(id) {
    const rec = els.get(id);
    if (rec) {
      if (rec.gradientObserver) rec.gradientObserver.disconnect();
      const win = windows.get(id);
      const renderer = win ? opts.getRenderer && opts.getRenderer(win.panel) : null;
      if (renderer && renderer.unmount && rec.handle) {
        try { renderer.unmount(rec.handle); } catch (e) {  }
      }
      if (rec.root.parentNode) rec.root.parentNode.removeChild(rec.root);
    }
    els.delete(id);
  }

  function hexRgb(h) {
    h = (h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    const n = parseInt(h, 16);
    return isNaN(n) || h.length !== 6 ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexRgba(h) {
    const rgb = hexRgb(h);
    const hex = (h || '').replace('#', '');
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return [...rgb, Number.isFinite(alpha) ? alpha : 1];
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
    const o = effOpts(win);
    const cell = Math.max(2, Number(o.border_cell) || 4);
    const cols = Math.max(3, Math.ceil(win.w / cell)), rows = Math.max(3, Math.ceil(win.h / cell));
    const cv = rec.bcanvas;
    if (cv.width !== cols || cv.height !== rows) { cv.width = cols; cv.height = rows; }
    cv.style.width = win.w + 'px';
    cv.style.height = win.h + 'px';
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cols, rows);
    const stops = (Array.isArray(o.border_stops) && o.border_stops.length >= 2
      ? o.border_stops
      : [o.border_color || '#ffffff', o.border_color2 || '#7ef7c6']).map(hexRgba);
    const n = 2 * (cols + rows) - 4, steps = 6, shift = (ts / 1000) * (Number(o.border_speed) || 0.15);
    rec.header.style.backgroundPosition = (-(shift % 1) * win.w * 2) + 'px 0';
    let i = 0;
    const put = (x, y) => {
      let t = ((i / n) + shift) % 1;
      t = t < 0.5 ? t * 2 : (1 - t) * 2;
      t = Math.round(t * steps) / steps;
      const stopPosition = t * (stops.length - 1);
      const stopIndex = Math.min(stops.length - 2, Math.floor(stopPosition));
      const stopProgress = stopPosition - stopIndex;
      const color = stops[stopIndex].map((v, k) => v + (stops[stopIndex + 1][k] - v) * stopProgress);
      ctx.fillStyle = `rgba(${Math.round(color[0])},${Math.round(color[1])},${Math.round(color[2])},${color[3]})`;
      ctx.fillRect(x, y, 1, 1);
      i++;
    };
    for (let x = 0; x < cols; x++) put(x, 0);
    for (let y = 1; y < rows; y++) put(cols - 1, y);
    for (let x = cols - 2; x >= 0; x--) put(x, rows - 1);
    for (let y = rows - 2; y >= 1; y--) put(0, y);
  }

  const BOX_GLYPHS = { single: '┌┐└┘─│', rounded: '╭╮╰╯─│', double: '╔╗╚╝═║', heavy: '┏┓┗┛━┃' };
  let cellCache = null;
  function cellSize() {
    if (!cellCache) {
      const s = document.createElement('span');
      s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:13px;font-family:var(--wm-mono)';
      s.textContent = 'M'.repeat(20);
      document.body.appendChild(s);
      const r = s.getBoundingClientRect();
      s.remove();
      cellCache = { w: r.width / 20, h: Math.round(r.height) };
    }
    return cellCache;
  }
  // box-drawing windows size in whole character cells so the frame tiles cleanly
  function snapSize(win, axis, v) {
    if (effOpts(win).border_mode !== 'box') return snap(v);
    const c = cellSize(), u = axis === 'w' ? c.w : c.h;
    return Math.round(Math.max(3, Math.round(v / u)) * u * 100) / 100;
  }
  function drawBox(win, rec, on) {
    const root = rec.root;
    root.classList.toggle('wm-box', on);
    if (!on) {
      root.style.padding = '';
      if (rec.box) { rec.box.remove(); rec.box = null; }
      return;
    }
    const o = effOpts(win), c = cellSize();
    const cols = Math.max(3, Math.round(win.w / c.w)), rows = Math.max(3, Math.round(win.h / c.h));
    const g = BOX_GLYPHS[o.box_style] || BOX_GLYPHS.single, inner = cols - 2;
    let t = (g[4] + ' ' + (win.title || '') + ' ').slice(0, inner);
    const lines = [g[0] + t + g[4].repeat(inner - t.length) + g[1]];
    for (let i = 1; i < rows - 1; i++) lines.push(g[5] + ' '.repeat(inner) + g[5]);
    lines.push(g[2] + g[4].repeat(inner) + g[3]);
    if (!rec.box) { rec.box = document.createElement('pre'); rec.box.className = 'wm-box-text'; root.appendChild(rec.box); }
    rec.box.style.cssText = 'color:' + (o.border_color || '') + ';line-height:' + c.h + 'px;width:' + (cols * c.w) + 'px;height:' + (rows * c.h) + 'px';
    rec.box.textContent = lines.join('\n');
    root.style.padding = c.h + 'px ' + c.w + 'px';
  }

  function applyBorder(win, rec) {
    const o = effOpts(win);
    const col = o.border_color || '';
    const col2 = o.border_color2 || '#7ef7c6';
    const stops = Array.isArray(o.border_stops) && o.border_stops.length >= 2
      ? o.border_stops
      : [col || '#ffffff', col2];
    const animatedStops = [...stops, ...stops.slice(0, -1).reverse()];
    const pixel = o.border_mode === 'pixel' && col;
    rec.root.style.borderColor = pixel ? 'transparent' : col;
    // titlebar follows the border: solid color, or an animated gradient in pixel mode
    rec.header.style.background = pixel
      ? `linear-gradient(90deg, ${animatedStops.join(', ')}) 0 0 / 200% 100% repeat-x`
      : col;
    if (o.title_color) {
      rec.header.style.color = o.title_color;
    } else if (col) {
      const [r, g, b] = hexRgb(col);
      rec.header.style.color = (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#0a0d0a' : '#ffffff';
    } else rec.header.style.color = '';
    const titleStops = Array.isArray(o.title_color_stops) ? o.title_color_stops : [];
    const title = rec.header.querySelector('.wm-title');
    if (title) {
      title.style.backgroundImage = titleStops.length >= 2 ? `linear-gradient(90deg, ${titleStops.join(', ')})` : '';
      title.style.backgroundClip = titleStops.length >= 2 ? 'text' : '';
      title.style.webkitBackgroundClip = titleStops.length >= 2 ? 'text' : '';
      title.style.webkitTextFillColor = titleStops.length >= 2 ? 'transparent' : '';
      title.style.color = titleStops.length >= 2 ? 'transparent' : '';
    }
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
    drawBox(win, rec, o.border_mode === 'box');
  }

  function applyGeometry(win, rec) {
    rec.root.style.left = win.x + 'px';
    rec.root.style.top = win.y + 'px';
    rec.root.style.width = win.w + 'px';
    rec.root.style.height = win.h + 'px';
    if (win.kind !== 'topmost') rec.root.style.zIndex = String(win.z);
    const shouldHideWindowInOverlay = !win.visible && !editable;
    rec.root.style.display = shouldHideWindowInOverlay ? 'none' : '';
    rec.root.style.opacity = (editable && win.visible === false) ? '0.35' : '';
    applyBorder(win, rec);
  }

  function applyTextGradient(body, rec, stops) {
    const gradient = stops.length >= 2 ? `linear-gradient(90deg, ${stops.join(', ')})` : '';
    if (gradient) {
      const wrapTextNodes = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.nodeValue.trim() || node.parentElement.closest('.wm-color-gradient-text')) continue;
          nodes.push(node);
        }
        nodes.forEach(node => {
          const span = document.createElement('span');
          span.className = 'wm-color-gradient-text';
          span.style.setProperty('--wm-text-gradient', gradient);
          node.parentNode.replaceChild(span, node);
          span.appendChild(node);
        });
      };
      wrapTextNodes(body);
      body.querySelectorAll('.wm-color-gradient-text').forEach(span => span.style.setProperty('--wm-text-gradient', gradient));
      if (!rec.gradientObserver) {
        rec.gradientObserver = new MutationObserver(records => {
          records.forEach(record => record.addedNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) wrapTextNodes(node.parentNode);
            else if (node.nodeType === Node.ELEMENT_NODE && !node.closest('.wm-color-gradient-text')) wrapTextNodes(node);
          }));
        });
        rec.gradientObserver.observe(body, { childList: true, subtree: true });
      }
      return;
    }
    if (rec.gradientObserver) {
      rec.gradientObserver.disconnect();
      rec.gradientObserver = null;
    }
    body.querySelectorAll('.wm-color-gradient-text').forEach(span => span.replaceWith(...span.childNodes));
  }

  function applyWindowOpts(win, rec) {
    if (opts.onWindowOptsChanged) opts.onWindowOptsChanged(win, rec);
    const values = effOpts(win);
    const bgStops = Array.isArray(values.bg_color_stops) ? values.bg_color_stops : [];
    rec.body.style.backgroundImage = bgStops.length >= 2 ? `linear-gradient(135deg, ${bgStops.join(', ')})` : '';
    if (values.bg_color) rec.body.style.backgroundColor = values.bg_color;
    const textStops = Array.isArray(values.text_color_stops) ? values.text_color_stops : [];
    applyTextGradient(rec.body, rec, textStops);
    if (values.text_color) rec.body.style.color = textStops.length >= 2 ? '' : values.text_color;
  }

  function renderWindow(win) {
    const root = document.createElement('div');
    root.className = 'wm-win wm-kind-' + win.kind;
    root.dataset.id = win.id;

    const header = document.createElement('div');
    header.className = 'wm-header';

    const title = document.createElement('span');
    title.className = 'wm-title';
    title.textContent = win.title;
    header.appendChild(title);

    if (editable) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'wm-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'remove window';
      closeBtn.onclick = (e) => { e.stopPropagation(); removeWindow(win.id); };
      header.appendChild(closeBtn);
    }

    const body = document.createElement('div');
    body.className = 'wm-body';

    root.appendChild(header);
    root.appendChild(body);
    stageEl.appendChild(root);

    const rec = { root, header, body, handle: null };
    els.set(win.id, rec);
    applyGeometry(win, rec);

    if (editable) {
      wireDrag(win, rec, header);
      wireResize(win, rec);
      root.addEventListener('mousedown', () => { if (!(win.opts && win.opts.locked)) select(win.id); });
    }

    rec.handle = renderBody(win, body, rec);
    applyWindowOpts(win, rec);
    if (win.kind === 'topmost') root.classList.add('wm-topmost');
  }

  function wireDrag(win, rec, handle) {
    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wm-close') || (win.opts && win.opts.locked)) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = win.x; origY = win.y;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      win.x = snap(origX + (e.clientX - startX));
      win.y = snap(origY + (e.clientY - startY));
      clampToStage(win);
      applyGeometry(win, rec);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      emitLayoutChange();
    });
  }

  function wireResize(win, rec) {
    const handle = document.createElement('div');
    handle.className = 'wm-resize-handle';
    rec.root.appendChild(handle);
    let resizing = false, startX = 0, startY = 0, origW = 0, origH = 0;
    handle.addEventListener('mousedown', (e) => {
      if (win.opts && win.opts.locked) return;
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      origW = win.w; origH = win.h;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      win.w = snapSize(win, 'w', Math.max(MIN_W, origW + (e.clientX - startX)));
      win.h = snapSize(win, 'h', Math.max(MIN_H, origH + (e.clientY - startY)));
      clampToStage(win);
      applyGeometry(win, rec);
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      emitLayoutChange();
    });
  }

  function showPopup(id, visible) {
    const win = windows.get(id);
    if (!win) return;
    win.visible = !!visible;
    if (visible) win.z = zCounter++;
    const rec = els.get(id);
    if (rec) applyGeometry(win, rec);
  }

  function getWindow(id) { return windows.get(id); }
  function forEachWindow(fn) { windows.forEach(fn); }
  function getBodyEl(id) { const rec = els.get(id); return rec ? rec.body : null; }
  function getRootEl(id) { const rec = els.get(id); return rec ? rec.root : null; }
  function getHandle(id) { const rec = els.get(id); return rec ? rec.handle : null; }

  return {
    setLayout, getLayout, addWindow, removeWindow, updateWindow,
    showPopup, getWindow, forEachWindow, getBodyEl, getRootEl, getHandle,
    bringToFront, select, setGridSize, currentGrid,
    undo, redo, canUndo: () => past.length > 0, canRedo: () => future.length > 0,
    getSelected: () => selectedId,
    setTheme, getTheme: () => theme,
    snapSize: (id, axis, v) => { const w = windows.get(id); return w ? snapSize(w, axis, v) : v; },
  };
}