// ctxmenu.js — tiny context menu. items: {label, hint?, disabled?, action?, submenu?:[...]} or '-' for a separator.
const ContextMenu = (() => {
  let layer = null;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const CSS = `
.cm{position:fixed;z-index:100000;min-width:190px;background:#0e1113;border:1px solid #3a4148;padding:3px 0;font:12px var(--mono, monospace);color:var(--text, #d8dee2)}
.cm-item{display:flex;justify-content:space-between;gap:18px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.cm-item:hover{background:rgba(255,178,56,.12);color:var(--amber, #ffb238)}
.cm-item.off{opacity:.35;pointer-events:none}
.cm-k{color:#5c656c}
.cm-sep{height:1px;margin:3px 0;background:#252c31}`;

  function kill(m) { if (m._sub) kill(m._sub); m.remove(); }
  function close() {
    if (layer) { layer.remove(); layer = null; }
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
  }
  function outside(e) { if (!e.target.closest || !e.target.closest('.cm')) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function build(items, x, y) {
    const m = document.createElement('div');
    m.className = 'cm';
    items.forEach(it => {
      if (it === '-' || it.sep) { const s = document.createElement('div'); s.className = 'cm-sep'; m.appendChild(s); return; }
      const r = document.createElement('div');
      r.className = 'cm-item' + (it.disabled ? ' off' : '');
      r.innerHTML = `<span>${esc(it.label)}</span><span class="cm-k">${it.submenu ? '▸' : esc(it.hint || '')}</span>`;
      r.onmouseenter = () => {
        if (m._sub) { kill(m._sub); m._sub = null; }
        if (it.submenu) { const b = r.getBoundingClientRect(); m._sub = build(it.submenu, b.right - 2, b.top - 3); }
      };
      if (!it.submenu) r.onclick = () => { close(); if (it.action) it.action(); };
      m.appendChild(r);
    });
    layer.appendChild(m);
    const b = m.getBoundingClientRect();
    m.style.left = Math.max(2, Math.min(x, innerWidth - b.width - 2)) + 'px';
    m.style.top = Math.max(2, Math.min(y, innerHeight - b.height - 2)) + 'px';
    return m;
  }

  function show(x, y, items) {
    close();
    if (!document.getElementById('cm-style')) {
      const st = document.createElement('style');
      st.id = 'cm-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    layer = document.createElement('div');
    document.body.appendChild(layer);
    build(items, x, y);
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', onKey, true);
  }
  return { show, close };
})();
