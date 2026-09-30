function createWM(opts) {
  const stageEl = opts.stageEl;
  const editable = !!opts.editable;
  const onLayoutChange = opts.onLayoutChange || (() => {});
  const renderBody = opts.renderBody || (() => {});
  const onSelect = opts.onSelect || (() => {});

  const GRID = opts.gridSize || 1; // px snap; 1 = off
  const MIN_W = 80, MIN_H = 60;

  let windows = new Map(); // id -> window state
  let els = new Map();     // id -> {root, body, header}
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

  // setLayout now DIFFS against the current window set instead of
  // destroying and recreating everything. this matters because a full
  // rebuild wipes each panel's in-memory handle (chat scrollback, the
  // current message text, tts transcript, etc) — previously *any* layout
  // broadcast (e.g. from a drag on control.html) would blank out
  // overlay.html's chat/message panels until the next full page reload.
  // now: unchanged windows keep their existing DOM + handle untouched,
  // changed windows get their geometry/opts patched in place, only
  // added/removed windows get mount/unmount calls.
  function setLayout(layoutArr, opts2) {
    opts2 = opts2 || {};
    suppressEmit = !!opts2.silent;

    const nextList = (layoutArr || []).map(normalizeWindow);
    const nextIds = new Set(nextList.map(w => w.id));

    // remove windows that no longer exist
    for (const id of Array.from(windows.keys())) {
      if (!nextIds.has(id)) {
        destroyWindowEl(id);
        windows.delete(id);
      }
    }

    // add or update
    for (const win of nextList) {
      const existing = windows.get(win.id);
      if (!existing) {
        windows.set(win.id, win);
        zCounter = Math.max(zCounter, (win.z || 0) + 1);
        renderWindow(win);
      } else {
        // same window (matched by id) — patch geometry/meta in place,
        // do NOT touch its mounted body/handle unless the panel type
        // itself changed (rare — treat as remove+add in that case).
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
        try { renderer.unmount(rec.handle); } catch (e) { /* ignore */ }
      }
      if (rec.root.parentNode) rec.root.parentNode.removeChild(rec.root);
    }
    els.delete(id);
  }

  function applyGeometry(win, rec) {
    rec.root.style.left = win.x + 'px';
    rec.root.style.top = win.y + 'px';
    rec.root.style.width = win.w + 'px';
    rec.root.style.height = win.h + 'px';
    if (win.kind !== 'topmost') rec.root.style.zIndex = String(win.z);
    const shouldHideWindowInOverlay = !win.visible && !editable;
    rec.root.style.display = shouldHideWindowInOverlay ? 'none' : '';
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