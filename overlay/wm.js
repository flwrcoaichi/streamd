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

  function emitLayoutChange() {
    if (suppressEmit) return;
    onLayoutChange(getLayout());
  }

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
          if (opts.onWindowOptsChanged) opts.onWindowOptsChanged(existing, rec);
        }
      }
    }

    suppressEmit = false;
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
      if (opts.onWindowOptsChanged) opts.onWindowOptsChanged(win, rec);
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
    rec.header.style.backgroundPosition = (-(shift % 1) * win.w * 2) + 'px 0';
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
    const col2 = o.border_color2 || '#7ef7c6';
    const pixel = o.border_mode === 'pixel' && col;
    rec.root.style.borderColor = pixel ? 'transparent' : col;
    // titlebar follows the border: solid color, or an animated gradient in pixel mode
    rec.header.style.background = pixel
      ? `linear-gradient(90deg, ${col}, ${col2}, ${col}) 0 0 / 200% 100% repeat-x`
      : col;
    if (o.title_color) {
      rec.header.style.color = o.title_color;
    } else if (col) {
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

  function applyGeometry(win, rec) {
    rec.root.style.left = win.x + 'px';
    rec.root.style.top = win.y + 'px';
    rec.root.style.width = win.w + 'px';
    rec.root.style.height = win.h + 'px';
    if (win.kind !== 'topmost') rec.root.style.zIndex = String(win.z);
    const shouldHideWindowInOverlay = !win.visible && !editable;
    rec.root.style.display = shouldHideWindowInOverlay ? 'none' : '';
    applyBorder(win, rec);
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
      root.addEventListener('mousedown', () => { bringToFront(win.id); select(win.id); });
    }

    rec.handle = renderBody(win, body, rec);
    if (win.kind === 'topmost') root.classList.add('wm-topmost');
  }

  function wireDrag(win, rec, handle) {
    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wm-close')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = win.x; origY = win.y;
      e.preventDefault();
      bringToFront(win.id);
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
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      origW = win.w; origH = win.h;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(win.id);
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      win.w = snap(Math.max(MIN_W, origW + (e.clientX - startX)));
      win.h = snap(Math.max(MIN_H, origH + (e.clientY - startY)));
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
  };
}