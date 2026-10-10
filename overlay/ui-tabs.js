// ui-tabs.js — editor chrome only. regroups control.html's existing DOM into
// icon-rail tabs without touching its logic (all ids stay valid after the move).
const UITabs = (() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  const CSS = `
.ut-rail{display:flex;flex-direction:column;gap:2px;flex:none;width:44px;padding:6px 0;background:#0e1113;border-right:1px solid #252c31}
.ut-tab{width:100% !important;margin:0 !important;min-height:40px !important;padding:4px 0 !important;display:flex !important;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  background:transparent !important;border:0 !important;border-left:2px solid transparent !important;border-radius:0 !important;color:#77828a;cursor:pointer}
.ut-tab:hover{color:var(--text)}
.ut-tab.on{color:var(--amber);border-left-color:var(--amber) !important;background:rgba(255,178,56,.08) !important}
.ut-ic{font:700 13px/1 var(--mono)}
.ut-lb{font-size:8px;letter-spacing:.06em;text-transform:uppercase}
.ut-pane[hidden],.pane[hidden]{display:none !important}
.ut-body{flex:1;min-width:0}
#win-editor{display:flex}
#win-editor .ut-rail{margin:0 12px 0 0;align-self:flex-start;position:sticky;top:0}
.ut-foot{position:sticky;bottom:0;background:#13181b;padding-top:8px;margin-top:12px;border-top:1px solid #252c31}
#layout-controls{display:flex;gap:10px}
#layout-controls .ut-rail{align-self:flex-start;position:sticky;top:0;margin-left:-4px}
#layout-controls .ut-pane select,#layout-controls .ut-pane input[type=text],#layout-controls .ut-pane input[type=number]{background:#0b0e10;border-color:#30383e;border-radius:5px;min-height:34px}
#view-panels.active{display:flex;align-items:stretch}
#view-panels .ut-rail{width:52px;min-height:calc(100vh - 48px)}
#view-panels .grid{flex:1;min-width:0;align-content:start}
/* compact color rows: swatch | hex | opacity on one line */
#layout-sidebar .color-control{grid-template-columns:34px minmax(0,1fr) auto;gap:6px}
#layout-sidebar .color-picker-trigger{width:34px;min-width:34px;height:30px;min-height:30px}
#layout-sidebar .color-control input[type=text]{min-height:30px}
#layout-sidebar .color-alpha{grid-column:auto;font-size:0;gap:0;padding:0}
#layout-sidebar .color-alpha output{font-size:10px;min-width:34px;text-align:right;color:#aeb8be}
#layout-sidebar .color-gradient-mode{width:auto;min-height:24px;margin-top:4px;font-size:10px}
#layout-sidebar .gradient-stops{grid-template-columns:1fr}
#layout-sidebar .gradient-stop{padding:6px}
#layout-sidebar .field-row{flex-wrap:wrap}`;

  function makeTabs(tabs, key, labels) {
    const rail = el('div', 'ut-rail'), body = el('div', 'ut-body');
    const btns = {}, panes = {};
    let cur = store.get(key, tabs[0].id);
    if (!tabs.some(t => t.id === cur)) cur = tabs[0].id;
    const show = (id, persist = true) => {
      cur = id;
      if (persist) store.set(key, id);
      tabs.forEach(t => { btns[t.id].classList.toggle('on', t.id === id); panes[t.id].hidden = t.id !== id; });
    };
    tabs.forEach(t => {
      const b = el('button', 'ut-tab');
      b.type = 'button'; b.title = t.label; b.setAttribute('aria-label', t.label);
      b.innerHTML = `<span class="ut-ic">${t.icon}</span>` + (labels ? `<span class="ut-lb">${t.label}</span>` : '');
      b.onclick = () => show(t.id);
      rail.appendChild(b); btns[t.id] = b;
      const p = el('div', 'ut-pane'); body.appendChild(p); panes[t.id] = p;
    });
    const avail = (id, ok) => {
      btns[id].style.display = ok ? '' : 'none';
      if (!ok && cur === id) { const f = tabs.find(t => btns[t.id].style.display !== 'none'); if (f) show(f.id, false); }
    };
    show(cur, false);
    return { rail, body, panes, show, avail };
  }

  // ── inspector ──
  const INSPECTOR_TABS = [
    { id: 'layout', icon: '▣', label: 'layout' }, { id: 'color', icon: '◐', label: 'color' },
    { id: 'text', icon: 'Aa', label: 'text' }, { id: 'border', icon: '┌┐', label: 'border' },
    { id: 'panel', icon: '≡', label: 'panel' }, { id: 'spacer', icon: '∿', label: 'spacer' },
  ];
  const RULES = [
    ['ed-social-lines-row', 'panel'], ['ed-wos-url-row', 'panel'], ['ed-key-panel-row', 'panel'],
    ['ed-canvas-size-row', 'panel'], ['ed-notepad-row', 'panel'], ['ed-latest-row', 'panel'],
    ['ed-spacer-kind-row', 'spacer'], ['ed-spacer-color-row', 'spacer'], ['ed-wireframe-shape-row', 'spacer'],
    ['ed-scroller-style-row', 'spacer'], ['ed-scroller-state-row', 'spacer'], ['ed-scroller-messages-row', 'spacer'],
    ['ed-spacer-pixel-row', 'spacer'], ['ed-border-mode', 'border'], ['ed-title-color-on', 'color'],
    ['ed-text-color', 'color'], ['ed-font-size', 'text'], ['ed-x', 'layout'], ['ed-w', 'layout'], ['ed-title', 'layout'],
  ];

  function inspector() {
    const ed = $('win-editor');
    if (!ed) return;
    const kids = Array.from(ed.children);
    const t = makeTabs(INSPECTOR_TABS, 'ut.inspector', true);
    const foot = el('div', 'ut-foot');
    kids.forEach(k => {
      if (k.classList.contains('side-title')) { k.remove(); return; }
      if (k.tagName === 'BUTTON') { foot.appendChild(k); return; }
      const rule = RULES.find(([id]) => k.id === id || k.querySelector('#' + id));
      t.panes[rule ? rule[1] : 'layout'].appendChild(k);
    });
    t.body.appendChild(foot);
    ed.append(t.rail, t.body);
    // a tab is only offered when one of its rows is currently shown
    setInterval(() => {
      if (ed.style.display === 'none') return;
      INSPECTOR_TABS.forEach(({ id }) => {
        t.avail(id, Array.from(t.panes[id].children).some(c => c.style.display !== 'none'));
      });
    }, 150);
  }

  // ── left sidebar (overlay / grid / add / list / theme) ──
  function leftRail() {
    const host = $('layout-controls');
    if (!host) return;
    const tabs = [
      { id: 'setup', icon: '▦', label: 'setup' }, { id: 'add', icon: '+', label: 'add' },
      { id: 'list', icon: '≣', label: 'list' }, { id: 'theme', icon: '◐', label: 'theme' },
    ];
    const map = { 'overlay': 'setup', 'grid snap': 'setup', 'add window': 'add', 'windows': 'list', 'bulk colors': 'theme' };
    const t = makeTabs(tabs, 'ut.left', true);
    let cur = 'setup';
    Array.from(host.children).forEach(k => {
      if (k.classList.contains('side-title')) cur = map[k.textContent.trim().toLowerCase()] || cur;
      t.panes[cur].appendChild(k);
    });
    host.append(t.rail, t.body);
  }

  // ── panels view ──
  function panelsView() {
    const view = $('view-panels');
    const grid = view && view.querySelector('.grid');
    if (!grid) return;
    const groups = [
      { id: 'stream', icon: '◉', label: 'stream', titles: ['overlay status', 'system', 'channel', 'ad breaks', 'pngtuber mood'] },
      { id: 'chat', icon: '▤', label: 'chat', titles: ['chat'] },
      { id: 'tts', icon: '♪', label: 'tts', titles: ['text to speech'] },
      { id: 'obs', icon: '▶', label: 'obs', titles: ['obs scenes', 'obs audio'] },
      { id: 'extras', icon: '✦', label: 'extras', titles: ['words on stream', 'canvas'] },
      { id: 'cmds', icon: '!', label: 'cmds', titles: ['bot commands', 'add / edit command'] },
    ];
    Array.from(grid.children).forEach(p => {
      const tl = p.querySelector('.pane-title');
      const name = tl && tl.firstChild ? tl.firstChild.textContent.trim().toLowerCase() : '';
      const g = groups.find(x => x.titles.includes(name));
      p.dataset.group = g ? g.id : 'stream';
    });
    const t = makeTabs(groups, 'ut.panels', true);
    const apply = id => Array.from(grid.children).forEach(p => { p.hidden = p.dataset.group !== id; });
    const pick = t.show;
    t.show = id => { pick(id); apply(id); };
    Array.from(t.rail.children).forEach((b, i) => { b.onclick = () => t.show(groups[i].id); });
    view.insertBefore(t.rail, grid);
    apply(store.get('ut.panels', 'stream'));
    pick(store.get('ut.panels', 'stream'), false);
  }

  function init() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    inspector(); leftRail(); panelsView();
  }
  return { init };
})();
UITabs.init();
