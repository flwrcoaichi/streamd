const WS_URL = `ws://${location.hostname}:8877`;
let ws = null;
let state = {};
let ttsReferenceSaveTimer = null;
const $ = id => document.getElementById(id);

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else toast('not connected to streamd');
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ── tabs ──────────────────────────────────────────────────────────────
const colorPickers = new WeakMap();
function enableAlpha(input) {
  if (input.dataset.colorControl) return;
  input.dataset.colorControl = 'true';
  const base = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const wrap = document.createElement('div');
  wrap.className = 'color-control';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'color-picker-trigger';
  trigger.setAttribute('aria-label', 'Choose color');
  wrap.appendChild(trigger);

  const hex = document.createElement('input');
  hex.type = 'text';
  hex.autocomplete = 'off';
  hex.spellcheck = false;
  hex.maxLength = 9;
  hex.setAttribute('aria-label', 'Hex color with optional alpha');
  hex.placeholder = '#RRGGBBAA';
  wrap.appendChild(hex);

  let opacity = 255;
  let picker = null;
  let syncingPicker = false;
  const updateFields = () => {
    const value = base.get.call(input).toUpperCase();
    hex.value = opacity >= 255 ? value : value + opacity.toString(16).padStart(2, '0').toUpperCase();
    trigger.style.setProperty('--swatch-color', value);
    trigger.style.setProperty('--swatch-opacity', String(opacity / 255));
  };
  const emitColorInput = () => input.dispatchEvent(new Event('input', { bubbles: true }));
  Object.defineProperty(input, 'value', {
    get() {
      const value = base.get.call(input);
      return opacity >= 255 ? value : value + opacity.toString(16).padStart(2, '0');
    },
    set(value) {
      let normalized = String(value || '').trim();
      let nextOpacity = 255;
      if (/^#[0-9a-f]{8}$/i.test(normalized)) {
        nextOpacity = parseInt(normalized.slice(7), 16);
        normalized = normalized.slice(0, 7);
      }
      if (!/^#[0-9a-f]{6}$/i.test(normalized)) normalized = '#ffffff';
      base.set.call(input, normalized);
      opacity = nextOpacity;
      updateFields();
      if (picker) {
        syncingPicker = true;
        try {
          picker.setColor(`${normalized}${nextOpacity.toString(16).padStart(2, '0')}`, true);
        } finally {
          syncingPicker = false;
        }
      }
    },
  });
  input.addEventListener('input', updateFields);
  hex.addEventListener('input', () => {
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex.value)) return;
    input.value = hex.value;
    emitColorInput();
  });
  hex.addEventListener('change', () => {
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex.value)) updateFields();
  });
  picker = Pickr.create({
    el: trigger,
    useAsButton: true,
    theme: 'classic',
    appClass: 'streamd-picker',
    default: input.value,
    comparison: false,
    closeOnScroll: true,
    position: 'bottom-middle',
    swatches: ['#ffb238', '#4ade80', '#5eb1ef', '#ff6b6b', '#c084fc', '#7ef7c6', '#ffffff', '#171a1d'],
    components: {
      preview: true,
      opacity: true,
      hue: true,
      interaction: { hex: true, rgba: true, input: true, save: true },
    },
  });
  picker.on('change', color => {
    if (syncingPicker) return;
    const value = color.toHEXA().toString();
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return;
    base.set.call(input, value.slice(0, 7));
    opacity = value.length === 9 ? parseInt(value.slice(7, 9), 16) : 255;
    updateFields();
    emitColorInput();
  });
  colorPickers.set(input, picker);
  updateFields();
}
document.querySelectorAll('#view-layout input[type=color]').forEach(enableAlpha);

function colorStops(container) {
  return Array.from(container.querySelectorAll('input[type=color]'), input => input.value);
}

function updateGradientPreview(container, preview) {
  const colors = colorStops(container);
  preview.style.backgroundImage = `linear-gradient(90deg, ${colors.join(', ')})`;
  const addButton = $(container.dataset.addButton);
  addButton.disabled = colors.length >= 5;
  addButton.title = colors.length >= 5 ? 'The gradient supports up to five stops' : 'Add a gradient color stop';
}

function gradientPreviewFor(container) {
  return $(container.dataset.preview);
}

function addGradientStop(container, color) {
  const index = container.querySelectorAll('input[type=color]').length;
  if (index >= 5) return;
  const stop = document.createElement('div');
  stop.className = 'gradient-stop dynamic';
  const head = document.createElement('div');
  head.className = 'gradient-stop-head';
  const title = document.createElement('span');
  title.textContent = `stop ${index + 1}`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'gradient-stop-remove';
  remove.textContent = 'remove';
  remove.setAttribute('aria-label', `Remove gradient stop ${index + 1}`);
  remove.onclick = () => {
    const input = stop.querySelector('input[type=color]');
    const picker = input && colorPickers.get(input);
    if (picker) picker.destroyAndRemove();
    stop.remove();
    renumberGradientStops(container);
    updateGradientPreview(container, gradientPreviewFor(container));
  };
  head.append(title, remove);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = color || '#7ef7c6';
  input.addEventListener('input', () => updateGradientPreview(container, gradientPreviewFor(container)));
  stop.append(head, input);
  enableAlpha(input);
  container.appendChild(stop);
  renumberGradientStops(container);
  updateGradientPreview(container, gradientPreviewFor(container));
}

function renumberGradientStops(container) {
  Array.from(container.querySelectorAll('.gradient-stop')).forEach((stop, index) => {
    const title = stop.querySelector('.gradient-stop-head span');
    if (title) title.textContent = `stop ${index + 1}`;
  });
}

function setGradientStops(container, colors) {
  container.querySelectorAll('.gradient-stop.dynamic').forEach(stop => {
    const input = stop.querySelector('input[type=color]');
    const picker = input && colorPickers.get(input);
    if (picker) picker.destroyAndRemove();
    stop.remove();
  });
  const inputs = container.querySelectorAll('input[type=color]');
  const values = colors.length >= 2 ? colors : ['#ffffff', '#7ef7c6'];
  inputs[0].value = values[0] || '#ffffff';
  if (inputs[1]) inputs[1].value = values[1] || '#7ef7c6';
  values.slice(2, 5).forEach(color => addGradientStop(container, color));
  updateGradientPreview(container, gradientPreviewFor(container));
}

[
  ['ed-border-stops', 'ed-border-preview', 'ed-border-add-stop'],
  ['bulk-border-stops', 'bulk-border-preview', 'bulk-border-add-stop'],
].forEach(([id, previewId, addButtonId]) => {
  const container = $(id);
  container.dataset.preview = previewId;
  container.dataset.addButton = addButtonId;
  container.querySelectorAll('input[type=color]').forEach(input => {
    input.addEventListener('input', () => updateGradientPreview(container, $(previewId)));
  });
});
$('ed-border-add-stop').onclick = () => {
  const stops = colorStops($('ed-border-stops'));
  addGradientStop($('ed-border-stops'), stops[stops.length - 1]);
};
$('bulk-border-add-stop').onclick = () => {
  const stops = colorStops($('bulk-border-stops'));
  addGradientStop($('bulk-border-stops'), stops[stops.length - 1]);
};
updateGradientPreview($('ed-border-stops'), $('ed-border-preview'));
updateGradientPreview($('bulk-border-stops'), $('bulk-border-preview'));

function createColorGradientEditor(input, optionKey, defaultSecond = '#7ef7c6') {
  const wrap = document.createElement('div');
  wrap.className = 'color-gradient-editor';
  wrap.dataset.optionKey = optionKey;

  const mode = document.createElement('select');
  mode.className = 'color-gradient-mode';
  mode.setAttribute('aria-label', `${input.id} color mode`);
  mode.innerHTML = '<option value="solid">solid color</option><option value="gradient">gradient</option>';
  wrap.appendChild(mode);

  const stops = document.createElement('div');
  stops.className = 'color-gradient-stops';
  stops.id = `gradient-${input.id}-stops`;
  stops.dataset.preview = `gradient-${input.id}-preview`;
  stops.dataset.addButton = `gradient-${input.id}-add`;
  const initialColors = [input.value || '#ffffff', defaultSecond];
  initialColors.forEach((color, index) => {
    const stop = document.createElement('div');
    stop.className = 'gradient-stop';
    const title = document.createElement('div');
    title.className = 'gradient-stop-head';
    title.textContent = `stop ${index + 1}`;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = color;
    colorInput.addEventListener('input', () => updateGradientPreview(stops, preview));
    stop.append(title, colorInput);
    stops.appendChild(stop);
    enableAlpha(colorInput);
  });
  wrap.appendChild(stops);

  const tools = document.createElement('div');
  tools.className = 'gradient-tools color-gradient-stops';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Add up to five gradient colors';
  const add = document.createElement('button');
  add.type = 'button';
  add.id = `gradient-${input.id}-add`;
  add.className = 'gradient-add';
  add.textContent = '+ stop';
  tools.append(hint, add);
  wrap.appendChild(tools);

  const preview = document.createElement('div');
  preview.className = 'gradient-preview color-gradient-stops';
  preview.id = `gradient-${input.id}-preview`;
  wrap.appendChild(preview);

  const colorWrap = input.closest('.color-control');
  colorWrap.after(wrap);
  add.onclick = () => {
    const current = colorStops(stops);
    addGradientStop(stops, current[current.length - 1]);
  };
  mode.addEventListener('change', () => {
    wrap.classList.toggle('enabled', mode.value === 'gradient');
    if (mode.value === 'gradient' && stops.querySelectorAll('input[type=color]').length < 2) {
      setGradientStops(stops, [input.value || '#ffffff', defaultSecond]);
    }
    updateGradientPreview(stops, preview);
  });
  updateGradientPreview(stops, preview);
  return wrap;
}

const colorGradientFields = [
  ['bulk-bg', 'bg_color_stops', '#263444'],
  ['bulk-text', 'text_color_stops', '#7ef7c6'],
  ['bulk-spacer', 'spacer_color_stops', '#7ef7c6'],
  ['ed-bg-color', 'bg_color_stops', '#263444'],
  ['ed-text-color', 'text_color_stops', '#7ef7c6'],
  ['ed-spacer-color', 'spacer_color_stops', '#7ef7c6'],
  ['ed-title-color', 'title_color_stops', '#ffb238'],
  ['ed-key-panel-active-color', 'active_color_stops', '#ffb238'],
  ['ed-key-panel-inactive-color', 'inactive_color_stops', '#354453'],
  ['ed-key-panel-border-color', 'border_color_stops', '#7ef7c6'],
  ['ed-key-panel-selected-color', 'selected_key_color_stops', '#ffb238'],
];
const colorGradientEditors = new Map();
colorGradientFields.forEach(([inputId, optionKey, second]) => {
  const input = $(inputId);
  if (!input) return;
  colorGradientEditors.set(inputId, createColorGradientEditor(input, optionKey, second));
});

function setColorGradient(inputId, colors) {
  const editor = colorGradientEditors.get(inputId);
  if (!editor) return;
  const input = $(inputId);
  const mode = editor.querySelector('.color-gradient-mode');
  const stops = editor.querySelector('.color-gradient-stops');
  if (Array.isArray(colors) && colors.length >= 2) {
    mode.value = 'gradient';
    editor.classList.add('enabled');
    setGradientStops(stops, colors.slice(0, 5));
  } else {
    mode.value = 'solid';
    editor.classList.remove('enabled');
    setGradientStops(stops, [input.value || '#ffffff', editor.dataset.defaultSecond || '#7ef7c6']);
  }
  updateGradientPreview(stops, $(stops.dataset.preview));
}

function selectedColorGradient(inputId) {
  const editor = colorGradientEditors.get(inputId);
  if (!editor || editor.querySelector('.color-gradient-mode').value !== 'gradient') return null;
  return colorStops(editor.querySelector('.color-gradient-stops'));
}

colorGradientEditors.forEach((editor, inputId) => {
  const field = colorGradientFields.find(item => item[0] === inputId);
  editor.dataset.defaultSecond = field[2];
  setColorGradient(inputId, null);
});

['ed-bg-color', 'ed-text-color'].forEach(inputId => {
  $(inputId).addEventListener('input', () => {
    const mode = colorGradientEditors.get(inputId).querySelector('.color-gradient-mode');
    if (mode.value !== 'solid') {
      mode.value = 'solid';
      mode.dispatchEvent(new Event('change'));
    }
    if (!selectedWinId) return;
    const win = wm.getWindow(selectedWinId);
    if (!win) return;
    const optionKey = inputId === 'ed-bg-color' ? 'bg_color' : 'text_color';
    const stopsKey = `${optionKey}_stops`;
    const opts = { ...(win.opts || {}), [optionKey]: $(inputId).value, [stopsKey]: [] };
    wm.updateWindow(win.id, { opts });
    if (window.refreshOverrideChips) window.refreshOverrideChips();
  });
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    $('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'layout') fitStage();
  };
});
const SPACER_COLOR_DEFAULTS = Panels.SPACER_COLOR_DEFAULTS;
const SPACER_CATEGORIES = {
  text: { label: 'Text', kinds: ['bootlog', 'scroller'] },
  pixel: { label: 'Pixel & retro', kinds: ['matrix', 'static', 'fire', 'starfield', 'rain', 'pipes', 'life', 'htop'] },
  geometric: { label: 'Geometric', kinds: ['oscilloscope', 'plasma', 'dna', 'metaballs', 'tunnel', 'rotozoom', 'copperbars', 'voronoi', 'wobble', 'floorgrid', 'bump', 'wireframe', 'trails', 'twister', 'fluid', 'waveform'] },
  interactive: { label: 'Interactive', kinds: ['cursor', 'cursor-ripple', 'cursor-particles', 'cursor-radar', 'chat-interactive'] },
  simulation: { label: 'Simulations', kinds: ['physics-demo', 'bouncing-ball', 'defrag-map', 'card-cascade'] },
  debug: { label: 'Debug', kinds: ['pointer-debug'] },
};
const SPACER_DESCRIPTIONS = {
  bootlog: 'Terminal boot sequence', scroller: 'Sine, marquee, and other text motion',
  matrix: 'Falling glyphs', static: 'Animated pixel noise', fire: 'Classic rising pixel fire',
  starfield: 'Stars rush toward the viewer', rain: 'Digital rain', pipes: 'Procedural connected pipes',
  life: 'Conway cellular automaton', htop: 'Live-style system bars',
  oscilloscope: 'Glowing signal trace', plasma: 'Retro color field', dna: 'Rotating double helix',
  metaballs: 'Soft merging blobs', tunnel: 'Infinite geometric tunnel', rotozoom: 'Rotating texture field',
  copperbars: 'Scrolling color bands', voronoi: 'Moving cell boundaries', wobble: 'Waving concentric rings',
  floorgrid: 'Perspective grid', bump: 'Light moving over a surface', wireframe: 'Rotating 3D shape',
  trails: 'Flowing particle trails', twister: 'Twisting ribbon', fluid: 'Shaded 3D fluid surface',
  waveform: 'Animated frequency bars', cursor: 'Pointer-bent dot mesh', 'cursor-ripple': 'Pointer-driven rings and ripples',
  'cursor-particles': 'Particles respond to pointer', 'cursor-radar': 'Radar sweep follows pointer',
  'chat-interactive': 'Chat messages become animated energy', 'physics-demo': 'Gravity, orbits, and force vectors',
  'bouncing-ball': 'A ball bounces under gravity', 'defrag-map': 'A disk map fills and defragments',
  'card-cascade': 'Layered windows cascade through space', 'pointer-debug': 'Inspect pointer data flow',
};
let spacerPickerCategory = 'all';

function renderSpacerPicker() {
  const select = $('ed-spacer-kind');
  const categoryHost = $('ed-spacer-categories');
  const results = $('ed-spacer-results');
  if (!select || !categoryHost || !results) return;
  const categories = [{ id: 'all', label: 'All' }, ...Object.entries(SPACER_CATEGORIES).map(([id, category]) => ({ id, label: category.label }))];
  categoryHost.innerHTML = categories.map(category =>
    `<button type="button" class="spacer-picker-category${spacerPickerCategory === category.id ? ' active' : ''}" data-category="${category.id}" aria-pressed="${spacerPickerCategory === category.id}">${category.label}</button>`
  ).join('');
  const query = $('ed-spacer-search').value.trim().toLowerCase();
  const options = [...select.options].filter(option => option.value);
  const matches = options.filter(option => {
    const categoryId = Object.keys(SPACER_CATEGORIES).find(id => SPACER_CATEGORIES[id].kinds.includes(option.value));
    return (spacerPickerCategory === 'all' || categoryId === spacerPickerCategory) &&
      (!query || `${option.textContent} ${SPACER_DESCRIPTIONS[option.value] || ''} ${categoryId || ''}`.toLowerCase().includes(query));
  });
  results.innerHTML = matches.length ? matches.map(option => {
    const color = SPACER_COLOR_DEFAULTS[option.value] || '#5ec8ff';
    const selected = option.value === select.value;
    return `<button type="button" class="spacer-picker-card${selected ? ' active' : ''}" role="option" aria-selected="${selected}" data-kind="${option.value}">
      <div class="spacer-picker-card-preview" style="background:linear-gradient(135deg,#101519,${color})"></div>
      <strong>${escapeHtml(option.textContent)}</strong>
      <span>${escapeHtml(SPACER_DESCRIPTIONS[option.value] || 'Animated spacer')}</span>
    </button>`;
  }).join('') : '<div class="spacer-picker-empty">No spacers match this search.</div>';
}

$('ed-spacer-categories').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  spacerPickerCategory = button.dataset.category;
  renderSpacerPicker();
});
$('ed-spacer-search').addEventListener('input', renderSpacerPicker);
$('ed-spacer-results').addEventListener('click', event => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  $('ed-spacer-kind').value = button.dataset.kind;
  $('ed-spacer-kind').dispatchEvent(new Event('change'));
  renderSpacerPicker();
});
renderSpacerPicker();

function snapKeyPanelValue(value) {
  // keys snap to at most 10px (finer if the window grid is finer) -- never to the 40px window grid
  const step = Math.max(1, Math.min(10, Number(wm && wm.currentGrid ? wm.currentGrid() : 1) || 1));
  return Math.max(0, Math.round((Number(value) || 0) / step) * step);
}

function keyPanelShapeRadius(shape) {
  switch ((shape || 'round').toLowerCase()) {
    case 'square': return '0px';
    case 'diamond': return '8px';
    case 'pill':
    case 'round':
    default: return '999px';
  }
}

function parseKeyPanelConfig(raw) {
  const lines = (raw || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
  const keys = [];
  for (const line of lines) {
    const parts = line.split(/[|,]/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const key = parts[0].toLowerCase();
    const color = parts[1] || '#7ef7c6';
    const shapeValue = parts[2] || 'round';
    const shape = ['round', 'square', 'pill', 'diamond'].includes(shapeValue.toLowerCase()) ? shapeValue.toLowerCase() : 'round';
    const x = Number.isFinite(Number(parts[3])) ? Number(parts[3]) : null;
    const y = Number.isFinite(Number(parts[4])) ? Number(parts[4]) : null;
    const colorStopsPart = parts.find(part => part.startsWith('gradient='));
    if (!key) continue;
    const item = {
      key,
      label: key === 'space' ? 'SPACE' : key.toUpperCase(),
      color,
      shape,
      active: false,
    };
    if (colorStopsPart) item.color_stops = colorStopsPart.slice('gradient='.length).split('~').filter(Boolean).slice(0, 5);
    if (x !== null) item.x = x;
    if (y !== null) item.y = y;
    keys.push(item);
  }
  const _ks = parseInt($('ed-key-panel-size').value, 10) || 48, _kg = parseInt($('ed-key-panel-gap').value, 10) || 8;
  keys.forEach((k, i) => { if (!Number.isFinite(k.x)) k.x = i * (_ks + _kg); if (!Number.isFinite(k.y)) k.y = 12; });
  return {
    shape: $('ed-key-panel-shape').value || 'round',
    size: parseInt($('ed-key-panel-size').value, 10) || 48,
    gap: parseInt($('ed-key-panel-gap').value, 10) || 8,
    glow: $('ed-key-panel-glow') ? $('ed-key-panel-glow').checked : true,
    border: $('ed-key-panel-border') ? $('ed-key-panel-border').checked : false,
    border_color: $('ed-key-panel-border-color') ? $('ed-key-panel-border-color').value || '#ffffff' : '#ffffff',
    border_width: $('ed-key-panel-border-width') ? parseInt($('ed-key-panel-border-width').value, 10) || 1 : 1,
    corner_radius: $('ed-key-panel-corner-radius') ? (Number($('ed-key-panel-corner-radius').value) || 0) : 0,
    active_color: $('ed-key-panel-active-color').value || '#7ef7c6',
    active_color_stops: selectedColorGradient('ed-key-panel-active-color'),
    inactive_color: $('ed-key-panel-inactive-color').value || '#1f2731',
    inactive_color_stops: selectedColorGradient('ed-key-panel-inactive-color'),
    border_color_stops: selectedColorGradient('ed-key-panel-border-color'),
    text_color: $('ed-text-color').value || '#f5f7fa',
    keys,
  };
}

function serializeKeyPanelConfig(cfg) {
  return (cfg.keys || []).map(k => {
    const parts = [String(k.key || '').toUpperCase() || 'KEY', k.color || '#7ef7c6', k.shape || 'round'];
    if (Number.isFinite(Number(k.x))) parts.push(String(Number(k.x)));
    if (Number.isFinite(Number(k.y))) parts.push(String(Number(k.y)));
    if (Array.isArray(k.color_stops) && k.color_stops.length >= 2) parts.push(`gradient=${k.color_stops.slice(0, 5).join('~')}`);
    return parts.join('|');
  }).join('\n');
}

function renderKeyPanelKeyList() {
  const list = $('ed-key-panel-key-list');
  const preview = $('ed-key-panel-preview');
  if (!list || !preview) return;
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  const selectedIdx = Number(preview.dataset.selectedIndex || 0);
  list.innerHTML = '';
  if (!cfg.keys.length) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--text-dimmer)';
    empty.style.fontSize = '11px';
    empty.textContent = 'no keys yet';
    list.appendChild(empty);
    return;
  }
  cfg.keys.forEach((key, idx) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'key-panel-editor-list-item' + (idx === selectedIdx ? ' active' : '');
    row.innerHTML = '<span class="key-panel-editor-swatch" style="background:' + (key.color || '#7ef7c6') + '"></span>' +
      '<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (key.label || key.key || 'KEY').toUpperCase() + '</span>' +
      '<span style="color:var(--text-dimmer);">' + (key.shape || 'round') + '</span>';
    if (key.color_stops && key.color_stops.length >= 2) {
      row.querySelector('.key-panel-editor-swatch').style.background = `linear-gradient(135deg, ${key.color_stops.join(', ')})`;
    }
    row.addEventListener('click', () => {
      preview.dataset.selectedIndex = String(idx);
      renderKeyPanelPreview();
    });
    list.appendChild(row);
  });
}

function syncSelectedKeyPanelEditor() {
  const preview = $('ed-key-panel-preview');
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  const idx = Number(preview && preview.dataset.selectedIndex ? preview.dataset.selectedIndex : 0);
  const key = cfg.keys[idx];
  const keyInput = $('ed-key-panel-selected-key');
  const shapeInput = $('ed-key-panel-selected-shape');
  const colorInput = $('ed-key-panel-selected-color');
  const xInput = $('ed-key-panel-selected-x');
  const yInput = $('ed-key-panel-selected-y');
  if (!key || !keyInput || !shapeInput || !colorInput || !xInput || !yInput) return;
  keyInput.value = key.key || '';
  shapeInput.value = key.shape || 'round';
  colorInput.value = key.color || '#7ef7c6';
  setColorGradient('ed-key-panel-selected-color', key.color_stops);
  xInput.value = Number.isFinite(Number(key.x)) ? Number(key.x) : 0;
  yInput.value = Number.isFinite(Number(key.y)) ? Number(key.y) : 0;
}

function updateSelectedKeyPanelFromEditor() {
  const preview = $('ed-key-panel-preview');
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  const idx = Number(preview && preview.dataset.selectedIndex ? preview.dataset.selectedIndex : 0);
  const key = cfg.keys[idx];
  if (!key) return;
  const keyName = $('ed-key-panel-selected-key').value.trim().toLowerCase() || key.key || 'w';
  key.key = keyName;
  key.shape = $('ed-key-panel-selected-shape').value || 'round';
  const selectedColorStops = selectedColorGradient('ed-key-panel-selected-color');
  key.color = selectedColorStops ? selectedColorStops[0] : ($('ed-key-panel-selected-color').value || '#7ef7c6');
  if (selectedColorStops) key.color_stops = selectedColorStops;
  else delete key.color_stops;
  key.x = Math.max(0, Math.round(Number($('ed-key-panel-selected-x').value) || 0));
  key.y = Math.max(0, Math.round(Number($('ed-key-panel-selected-y').value) || 0));
  if (!Number.isFinite(key.x)) delete key.x; else key.x = Math.max(0, key.x);
  if (!Number.isFinite(key.y)) delete key.y; else key.y = Math.max(0, key.y);
  $('ed-key-panel-keys').value = serializeKeyPanelConfig(cfg);
  renderKeyPanelPreview();
}

function renderKeyPanelPreview() {
  const preview = $('ed-key-panel-preview');
  if (!preview) return;
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  if (!cfg.keys.length) {
    preview.dataset.selectedIndex = '0';
    preview.innerHTML = '';
    renderKeyPanelKeyList();
    syncSelectedKeyPanelEditor();
    return;
  }
  let selectedIndex = Number(preview.dataset.selectedIndex || 0);
  if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || selectedIndex >= cfg.keys.length) {
    selectedIndex = 0;
  }
  preview.dataset.selectedIndex = String(selectedIndex);
  const size = parseInt($('ed-key-panel-size').value, 10) || 48;
  const gap = parseInt($('ed-key-panel-gap').value, 10) || 8;
  const shapeFallback = $('ed-key-panel-shape').value || 'round';
  preview.innerHTML = '';
  preview.style.width = '100%';
  preview.style.height = '140px';
  (cfg.keys || []).forEach((key, idx) => {
    const el = document.createElement('div');
    const glyphName = String(key.key || '').toLowerCase();
    const label = glyphName === 'up' ? '↑' : glyphName === 'down' ? '↓' : glyphName === 'left' ? '←' : glyphName === 'right' ? '→' : (key.label || key.key || '').toUpperCase();
    el.className = 'key-panel-editor-key key-panel-' + (key.shape || shapeFallback) + (idx === selectedIndex ? ' selected' : '');
    el.textContent = label;
    const keyColor = key.color || cfg.active_color || '#7ef7c6';
    const inactive = cfg.inactive_color || '#1f2731';
    const cx = Number(key.x), cy = Number(key.y);
    const borderEnabled = cfg.border !== false;
    const borderWidth = Number.isFinite(Number(cfg.border_width)) ? Number(cfg.border_width) : 1;
    const borderColor = cfg.border_color || '#ffffff';
    const radiusValue = Number.isFinite(Number(cfg.corner_radius)) ? `${Number(cfg.corner_radius)}px` : keyPanelShapeRadius(key.shape || shapeFallback);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.background = key.color_stops && key.color_stops.length >= 2
      ? `linear-gradient(135deg, ${key.color_stops.join(', ')})`
      : cfg.active_color_stops && cfg.active_color_stops.length >= 2
        ? `linear-gradient(135deg, ${cfg.active_color_stops.join(', ')})`
        : keyColor;
    el.style.border = borderEnabled ? `${borderWidth}px solid ${borderColor}` : 'none';
    el.style.borderImage = borderEnabled && cfg.border_color_stops && cfg.border_color_stops.length >= 2
      ? `linear-gradient(135deg, ${cfg.border_color_stops.join(', ')}) 1`
      : 'none';
    el.style.borderRadius = radiusValue;
    el.style.color = '#08120d';
    el.style.setProperty('--key-color', keyColor);
    el.style.setProperty('--key-bg', inactive);
    el.style.setProperty('--key-text', cfg.text_color || '#f5f7fa');
    el.dataset.index = String(idx);
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      preview.dataset.selectedIndex = String(idx);
      renderKeyPanelPreview();
      const keyCfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
      const item = keyCfg.keys[idx];
      if (!item) return;
      const dragStart = {
        x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
        y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
        pointerX: event.clientX,
        pointerY: event.clientY,
      };
      const onMove = (moveEvent) => {
        const cfgNow = parseKeyPanelConfig($('ed-key-panel-keys').value);
        const activeItem = cfgNow.keys[idx];
        if (!activeItem) return;
        const nextX = Math.max(0, snapKeyPanelValue(dragStart.x + Math.round(moveEvent.clientX - dragStart.pointerX)));
        const nextY = Math.max(0, snapKeyPanelValue(dragStart.y + Math.round(moveEvent.clientY - dragStart.pointerY)));
        activeItem.x = nextX;
        activeItem.y = nextY;
        $('ed-key-panel-keys').value = serializeKeyPanelConfig(cfgNow);
        renderKeyPanelPreview();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    preview.appendChild(el);
  });
  renderKeyPanelKeyList();
  syncSelectedKeyPanelEditor();
}

function addKeyPanelKey() {
  const name = prompt('key name to add (e.g. w, up, ctrl, space)', 'w');
  if (!name || !name.trim()) return;
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  const keyName = name.trim().toLowerCase();
  const item = {
    key: keyName,
    label: keyName === 'space' ? 'SPACE' : keyName === 'up' ? '↑' : keyName === 'down' ? '↓' : keyName === 'left' ? '←' : keyName === 'right' ? '→' : keyName.toUpperCase(),
    color: cfg.active_color || '#7ef7c6',
    shape: $('ed-key-panel-shape').value || 'round',
    x: (cfg.keys.length || 0) * ((parseInt($('ed-key-panel-size').value, 10) || 48) + (parseInt($('ed-key-panel-gap').value, 10) || 8)),
    y: 12,
    active: false,
  };
  cfg.keys.push(item);
  $('ed-key-panel-preview').dataset.selectedIndex = String(cfg.keys.length - 1);
  $('ed-key-panel-keys').value = serializeKeyPanelConfig(cfg);
  renderKeyPanelPreview();
}

function removeSelectedKeyPanelKey() {
  const preview = $('ed-key-panel-preview');
  if (!preview) return;
  const cfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
  const idx = Number(preview.dataset.selectedIndex || 0);
  if (!cfg.keys[idx]) return;
  cfg.keys.splice(idx, 1);
  preview.dataset.selectedIndex = String(Math.max(0, idx - 1));
  $('ed-key-panel-keys').value = serializeKeyPanelConfig(cfg);
  renderKeyPanelPreview();
}

['ed-key-panel-shape', 'ed-key-panel-size', 'ed-key-panel-gap', 'ed-key-panel-active-color', 'ed-key-panel-inactive-color', 'ed-key-panel-keys', 'ed-key-panel-glow', 'ed-key-panel-border', 'ed-key-panel-border-width', 'ed-key-panel-border-color', 'ed-key-panel-corner-radius', 'ed-key-panel-selected-key', 'ed-key-panel-selected-shape', 'ed-key-panel-selected-color', 'ed-key-panel-selected-x', 'ed-key-panel-selected-y'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    if (id.startsWith('ed-key-panel-selected-')) updateSelectedKeyPanelFromEditor();
    else renderKeyPanelPreview();
  });
  el.addEventListener('change', () => {
    if (id.startsWith('ed-key-panel-selected-')) updateSelectedKeyPanelFromEditor();
    else renderKeyPanelPreview();
  });
});

$('ed-key-panel-add-key')?.addEventListener('click', addKeyPanelKey);
$('ed-key-panel-remove-key')?.addEventListener('click', removeSelectedKeyPanelKey);

let scrollerEditState = 'default'; // which state's message pool is shown in the textarea
$('ed-spacer-kind').addEventListener('change', () => {
  $('ed-spacer-color').value = SPACER_COLOR_DEFAULTS[$('ed-spacer-kind').value] || '#00ff66';
});
// ── layout editor ─────────────────────────────────────────────────────

let selectedWinId = null;
let currentOverlay = 'main';
const editorHandles = new Map();

// id generation: previously a session-local counter starting at 1 meant
// re-adding a window (e.g. a second "spacer") after a layout reload could
// collide with an id that already exists in the loaded layout (since the
// counter didn't know about ids that came from the server/a saved
// config) — the new window would silently overwrite/merge with the old
// one in the windows Map. now we scan existing ids on every add and on
// layout load, so new ids are always unique regardless of what's already
// on the board — multiple spacer windows (spacer_1, spacer_2, ...) work.
function nextIdFor(panelType) {
  let n = 1;
  const existing = new Set(wm.getLayout().map(w => w.id));
  Object.values(state.wm_layouts || {}).forEach(l => (l || []).forEach(w => existing.add(w.id)));
  while (existing.has(panelType + '_' + n)) n++;
  return panelType + '_' + n;
}

const wm = createWM({
  stageEl: document.getElementById('stage'),
  editable: true,
  gridSize: 40,
  getRenderer: (panelName) => Panels[panelName],
  onSelect: (id) => { selectedWinId = id; refreshWinEditor(); refreshWinList(); },
  onLayoutChange: (layout) => {
    state.wm_layouts = state.wm_layouts || {};
    state.wm_layouts[currentOverlay] = layout;
    send({ cmd: 'wm_layout_set', name: currentOverlay, layout });
    refreshWinList();
  },
  renderBody: (win, bodyEl) => {
    const renderer = Panels[win.panel];
    if (!renderer) { bodyEl.textContent = 'unknown: ' + win.panel; return null; }
    const h = renderer.mount(bodyEl, win, {});
    editorHandles.set(win.id, h);
    if (win.panel === 'pngtuber') {
      fetch('/pngtuber-list').then(r => r.ok ? r.json() : {}).then(a => {
        if (renderer && h && renderer.onState) renderer.onState(h, 'assets', a, {}, wm, win.id);
      }).catch(() => {});
    }
    return h;
  },
  onWindowOptsChanged: (win, rec) => {
    const renderer = Panels[win.panel];
    const h = editorHandles.get(win.id);
    if (renderer && renderer.applyOpts && h) renderer.applyOpts(h, win);
  },
});

$('grid-snap-select').addEventListener('change', () => {
  const px = parseInt($('grid-snap-select').value, 10) || 1;
  wm.setGridSize(px);
  const wrap = $('layout-stage-wrap');
  wrap.classList.remove('snap-20', 'snap-40', 'snap-80');
  if (px === 20) wrap.classList.add('snap-20');
  else if (px === 40) wrap.classList.add('snap-40');
  else if (px === 80) wrap.classList.add('snap-80');
  else wrap.style.backgroundSize = px > 1 ? `${px}px ${px}px` : '0 0';
});

WMEditor.attach(wm, { onCommit: () => refreshWinList(), onRefresh: () => refreshWinEditor() });

function fitStage() {
  const wrap = $('layout-stage-wrap');
  const inner = $('layout-stage-inner');
  const scale = Math.min(wrap.clientWidth / 1440, wrap.clientHeight / 1080);
  inner.style.left = `${(wrap.clientWidth - 1440 * scale) / 2}px`;
  inner.style.top = `${(wrap.clientHeight - 1080 * scale) / 2}px`;
  inner.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', fitStage);

function refreshWinList() {
  const list = $('win-list');
  list.innerHTML = '';
  wm.forEachWindow(win => {
    const item = document.createElement('div');
    item.className = 'win-list-item' + (win.id === selectedWinId ? ' selected' : '');
    item.innerHTML = `<span>${escapeHtml(win.title)} <span style="color:var(--text-dimmer)">[${win.panel}]</span></span><span class="rm">✕</span>`;
    item.onclick = (e) => {
      if (e.target.classList.contains('rm')) { wm.removeWindow(win.id); if (selectedWinId === win.id) { selectedWinId = null; refreshWinEditor(); } return; }
      wm.select(win.id);
      wm.bringToFront(win.id);
    };
    list.appendChild(item);
  });
}

function refreshWinEditor() {
  const ed = $('win-editor');
  const empty = $('win-editor-empty');
  const title = $('inspector-title');
  if (!selectedWinId) {
    ed.style.display = 'none';
    empty.style.display = '';
    title.textContent = 'Properties';
    return;
  }
  const win = wm.getWindow(selectedWinId);
  if (!win) {
    ed.style.display = 'none';
    empty.style.display = '';
    title.textContent = 'Properties';
    return;
  }
  ed.style.display = '';
  empty.style.display = 'none';
  title.textContent = win.title;
  $('ed-x').value = win.x; $('ed-y').value = win.y;
  $('ed-w').value = win.w; $('ed-h').value = win.h;
  $('ed-title').value = win.title;
  $('ed-text-color').value = (win.opts && win.opts.text_color) || wm.getTheme().text_color || '#d8dee2';
  $('ed-bg-color').value = (win.opts && win.opts.bg_color) || wm.getTheme().bg_color || '#0a0c0d';
  $('ed-font-size').value = win.opts && win.opts.font_size || 13;
  $('ed-font-family').value = win.opts && win.opts.font_family || 'monospace';
  $('ed-social-lines').value = win.opts && win.opts.social_lines || 'twitter: @vanillyn_net\ndiscord: @vanillyn';
  $('ed-wos-url').value = (win.opts && win.opts.wos_url) || 'https://wos.gg/';
  $('ed-canvas-size').value = (win.opts && win.opts.size) || 100;
  const keyCfg = win.opts || {
    shape: 'round', size: 48, gap: 8, active_color: '#7ef7c6', inactive_color: '#1f2731', text_color: '#f5f7fa',
    keys: [{ key: 'w', label: 'W', color: '#7ef7c6', shape: 'round' }, { key: 'a', label: 'A', color: '#7ef7c6', shape: 'square' }, { key: 's', label: 'S', color: '#7ef7c6', shape: 'square' }, { key: 'd', label: 'D', color: '#7ef7c6', shape: 'square' }, { key: 'space', label: 'SPACE', color: '#8be9fd', shape: 'pill' }]
  };
  $('ed-key-panel-shape').value = keyCfg.shape || 'round';
  $('ed-key-panel-size').value = keyCfg.size || 48;
  $('ed-key-panel-gap').value = keyCfg.gap || 8;
  $('ed-key-panel-glow').checked = keyCfg.glow !== false;
  $('ed-key-panel-border').checked = keyCfg.border === true;
  $('ed-key-panel-border-width').value = Number(keyCfg.border_width || 1);
  $('ed-key-panel-border-color').value = keyCfg.border_color || '#ffffff';
  $('ed-key-panel-corner-radius').value = Number(keyCfg.corner_radius || 0);
  $('ed-key-panel-active-color').value = keyCfg.active_color || '#7ef7c6';
  $('ed-key-panel-inactive-color').value = keyCfg.inactive_color || '#1f2731';
  $('ed-key-panel-keys').value = (keyCfg.keys || []).map(k => {
    const keyName = (k.key || '').toUpperCase().replace('SPACE', 'Space');
    const line = [keyName, k.color || '#7ef7c6', k.shape || 'round'];
    if (Number.isFinite(Number(k.x))) line.push(String(Number(k.x)));
    if (Number.isFinite(Number(k.y))) line.push(String(Number(k.y)));
    if (Array.isArray(k.color_stops) && k.color_stops.length >= 2) line.push(`gradient=${k.color_stops.slice(0, 5).join('~')}`);
    return line.join('|');
  }).join('\n');
  renderKeyPanelPreview();

  const isSpacer = win.panel === 'spacer';
  $('ed-spacer-kind-row').style.display = isSpacer ? '' : 'none';
  $('ed-spacer-color-row').style.display = isSpacer ? '' : 'none';
  $('ed-spacer-bg-row').style.display = isSpacer ? '' : 'none';
  const savedSpacerKind = win.opts && win.opts.spacer_kind;
  const spacerKind = savedSpacerKind === 'typewriter' ? 'bootlog' : savedSpacerKind === 'torus' ? 'wireframe' : savedSpacerKind;
  $('ed-wireframe-shape-row').style.display = (isSpacer && spacerKind === 'wireframe') ? '' : 'none';
  const isScroller = isSpacer && spacerKind === 'scroller';
  const isCursorSpacer = isSpacer && ['cursor', 'cursor-ripple', 'cursor-particles', 'cursor-radar'].includes(spacerKind);
  $('ed-cursor-style-options').style.display = isCursorSpacer ? '' : 'none';
  $('ed-scroller-style-row').style.display = isScroller ? '' : 'none';
  $('ed-scroller-state-row').style.display = isScroller ? '' : 'none';
  $('ed-scroller-messages-row').style.display = isScroller ? '' : 'none';

  if (isSpacer) {
    $('ed-spacer-kind').value = spacerKind || 'bootlog';
    $('ed-spacer-color').value = (win.opts && win.opts.spacer_color) || SPACER_COLOR_DEFAULTS[$('ed-spacer-kind').value] || '#00ff66';
    $('ed-spacer-bg-color').value = (win.opts && win.opts.spacer_bg_color) || '#000000';
    renderSpacerPicker();
  }
  if (isSpacer) {
    const spacerOpts = win.opts || {};
    const setRange = (id, option, fallback, suffix) => {
      const input = $(id);
      input.value = spacerOpts[option] ?? fallback;
      $(`${id}-value`).textContent = `${input.value}${suffix}`;
    };
    setRange('ed-cursor-spacing', 'spacer_cursor_spacing', 28, ' px');
    setRange('ed-cursor-dot-size', 'spacer_cursor_dot_size', 2, ' px');
    setRange('ed-cursor-spacing-opacity', 'spacer_cursor_spacing_opacity', 50, '%');
    setRange('ed-cursor-marker-size', 'spacer_cursor_marker_size', 12, ' px');
    setRange('ed-cursor-radius', 'spacer_cursor_radius', 180, ' px');
    setRange('ed-cursor-strength', 'spacer_cursor_strength', 70, '%');
    setRange('ed-cursor-speed', 'spacer_cursor_speed', 100, '%');
    $('ed-cursor-spacing-color').value = spacerOpts.spacer_cursor_spacing_color || '#31404a';
    $('ed-cursor-accent-color').value = spacerOpts.spacer_cursor_accent_color ||
      spacerOpts.spacer_color || SPACER_COLOR_DEFAULTS[spacerKind] || '#5ec8ff';
    $('ed-cursor-marker').checked = spacerOpts.spacer_cursor_marker !== false;
  }
  if (spacerKind === 'wireframe') {
    $('ed-wireframe-shape').value = (savedSpacerKind === 'torus' ? 'torus' : win.opts.spacer_wireframe_shape) || 'cube';
  }
  if (isScroller) {
    $('ed-scroller-style').value = win.opts.spacer_scroller_style || 'sine';
    scrollerEditState = win.opts.spacer_state || 'default';
    $('ed-scroller-state').value = scrollerEditState;
    const customMsgs = (win.opts.spacer_scroller_messages && win.opts.spacer_scroller_messages[scrollerEditState]) || [];
    $('ed-scroller-messages').value = customMsgs.join('\n');
  }

  $('ed-social-lines-row').style.display = win.panel === 'socials' ? '' : 'none';
  $('ed-wos-url-row').style.display = win.panel === 'words' ? '' : 'none';
  $('ed-key-panel-row').style.display = win.panel === 'key_panel' ? '' : 'none';
  $('ed-canvas-size-row').style.display = win.panel === 'canvas' ? '' : 'none';
  const wo = Object.assign({}, wm.getTheme(), win.opts || {});
  colorGradientFields.forEach(([inputId, optionKey]) => {
    if (inputId.startsWith('ed-') && inputId !== 'ed-key-panel-selected-color') {
      setColorGradient(inputId, wo[optionKey]);
    }
  });
  $('ed-border-mode').value = wo.border_mode || 'default';
  $('ed-box-style').value = wo.box_style || 'single';
  setGradientStops($('ed-border-stops'), wo.border_stops || [wo.border_color || '#ffffff', wo.border_color2 || '#7ef7c6']);
  $('ed-title-color-on').checked = !!wo.title_color;
  $('ed-title-color').value = wo.title_color || '#0a0d0a';
  $('ed-spacer-pixel-row').style.display = isSpacer ? '' : 'none';
  $('ed-spacer-pixel').value = wo.spacer_pixel || 2;
  $('ed-notepad-row').style.display = win.panel === 'notepad' ? '' : 'none';
  if (win.panel === 'notepad') {
    $('ed-notepad-md').checked = wo.notepad_markdown !== false;
    $('ed-notepad-text').value = (state.notepads || {})[win.id] || '';
  }
  $('ed-latest-row').style.display = win.panel === 'latest' ? '' : 'none';
  if (win.panel === 'latest') $('ed-latest-show').value = wo.latest_show || 'both';
}

$('btn-apply-edit').onclick = () => {
  if (!selectedWinId) return;
  const win = wm.getWindow(selectedWinId);
  if (!win) return;
  const patch = {
    x: parseInt($('ed-x').value, 10) || 0,
    y: parseInt($('ed-y').value, 10) || 0,
    w: parseInt($('ed-w').value, 10) || 80,
    h: parseInt($('ed-h').value, 10) || 60,
    title: $('ed-title').value.trim() || win.panel,
  };
  const opts = { ...(win.opts || {}) };
  opts.text_color = $('ed-text-color').value || '#d8dee2';
  opts.bg_color = $('ed-bg-color').value || '#0a0c0d';
  colorGradientFields.forEach(([inputId, optionKey]) => {
    if (!inputId.startsWith('ed-') || inputId === 'ed-key-panel-selected-color') return;
    const appliesToPanel =
      inputId === 'ed-bg-color' ||
      inputId === 'ed-text-color' ||
      (win.panel === 'spacer' && inputId === 'ed-spacer-color') ||
      (win.panel === 'key_panel' && !window.KeyPanelEditor && inputId.startsWith('ed-key-panel-'));
    if (!appliesToPanel) return;
    const stops = selectedColorGradient(inputId);
    if (stops) opts[optionKey] = stops;
    else if (inputId === 'ed-bg-color' || inputId === 'ed-text-color') opts[optionKey] = [];
    else delete opts[optionKey];
  });
  opts.font_size = parseInt($('ed-font-size').value, 10) || 13;
  opts.font_family = $('ed-font-family').value || 'monospace';
  if (win.panel === 'spacer') {
    opts.spacer_kind = $('ed-spacer-kind').value;
    opts.spacer_color = selectedColorGradient('ed-spacer-color')?.[0] ||
      $('ed-spacer-color').value || SPACER_COLOR_DEFAULTS[opts.spacer_kind] || '#00ff66';
    opts.spacer_bg_color = $('ed-spacer-bg-color').value || '#000000';
    if (['cursor', 'cursor-ripple', 'cursor-particles', 'cursor-radar'].includes(opts.spacer_kind)) {
      opts.spacer_cursor_spacing = Number($('ed-cursor-spacing').value);
      opts.spacer_cursor_dot_size = Number($('ed-cursor-dot-size').value);
      opts.spacer_cursor_spacing_opacity = Number($('ed-cursor-spacing-opacity').value);
      opts.spacer_cursor_marker_size = Number($('ed-cursor-marker-size').value);
      opts.spacer_cursor_spacing_color = $('ed-cursor-spacing-color').value;
      opts.spacer_cursor_accent_color = $('ed-cursor-accent-color').value;
      opts.spacer_cursor_radius = Number($('ed-cursor-radius').value);
      opts.spacer_cursor_strength = Number($('ed-cursor-strength').value);
      opts.spacer_cursor_speed = Number($('ed-cursor-speed').value);
      opts.spacer_cursor_marker = $('ed-cursor-marker').checked;
    }
    if (opts.spacer_kind === 'wireframe') {
      opts.spacer_wireframe_shape = $('ed-wireframe-shape').value;
    }
    if (opts.spacer_kind === 'scroller') {
      opts.spacer_scroller_style = $('ed-scroller-style').value;
      const selectedState = $('ed-scroller-state').value;
      if (selectedState === 'default') delete opts.spacer_state;
      else opts.spacer_state = selectedState;
      const lines = $('ed-scroller-messages').value.split('\n').map(s => s.trim()).filter(Boolean);
      opts.spacer_scroller_messages = { ...(opts.spacer_scroller_messages || {}) };
      if (lines.length) opts.spacer_scroller_messages[scrollerEditState] = lines;
      else delete opts.spacer_scroller_messages[scrollerEditState];
    }
  }
  if (win.panel === 'socials') opts.social_lines = $('ed-social-lines').value.trim();
  if (win.panel === 'words') opts.wos_url = $('ed-wos-url').value.trim() || 'https://wos.gg/';
  if (win.panel === 'key_panel' && !window.KeyPanelEditor) {
    const keyCfg = parseKeyPanelConfig($('ed-key-panel-keys').value);
    opts.shape = $('ed-key-panel-shape').value || 'round';
    opts.size = parseInt($('ed-key-panel-size').value, 10) || 48;
    opts.gap = parseInt($('ed-key-panel-gap').value, 10) || 8;
    opts.glow = $('ed-key-panel-glow').checked;
    opts.border = $('ed-key-panel-border').checked;
    opts.border_color = selectedColorGradient('ed-key-panel-border-color')?.[0] || $('ed-key-panel-border-color').value || '#ffffff';
    opts.border_width = parseInt($('ed-key-panel-border-width').value, 10) || 1;
    opts.corner_radius = Number($('ed-key-panel-corner-radius').value) || 0;
    opts.active_color = selectedColorGradient('ed-key-panel-active-color')?.[0] || $('ed-key-panel-active-color').value || '#7ef7c6';
    opts.inactive_color = selectedColorGradient('ed-key-panel-inactive-color')?.[0] || $('ed-key-panel-inactive-color').value || '#1f2731';
    opts.text_color = $('ed-text-color').value || '#f5f7fa';
    opts.keys = keyCfg.keys;
    send({ cmd: 'key_panel_set', key_panel: { ...opts } });
  }
  if (win.panel === 'canvas') opts.size = parseInt($('ed-canvas-size').value, 10) || 100;
  const bm = $('ed-border-mode').value;
  if (bm === 'default') { delete opts.border_mode; delete opts.border_color; delete opts.border_color2; }
  else {
    const stops = colorStops($('ed-border-stops'));
    opts.border_mode = bm;
    opts.border_color = stops[0];
    opts.border_color2 = stops[1];
    opts.border_stops = stops;
  }
  if (bm === 'default') delete opts.border_stops;
  if (bm === 'box') opts.box_style = $('ed-box-style').value; else delete opts.box_style;
  if (win.panel === 'spacer') opts.spacer_pixel = parseInt($('ed-spacer-pixel').value, 10) || 2;
  if (win.panel === 'notepad') opts.notepad_markdown = $('ed-notepad-md').checked;
  if (win.panel === 'latest') opts.latest_show = $('ed-latest-show').value;
  if ($('ed-title-color-on').checked) {
    const titleStops = selectedColorGradient('ed-title-color');
    opts.title_color = titleStops?.[0] || $('ed-title-color').value;
    if (titleStops) opts.title_color_stops = titleStops;
    else delete opts.title_color_stops;
  }
  else { delete opts.title_color; delete opts.title_color_stops; }
  patch.opts = opts;
  wm.updateWindow(selectedWinId, patch);
  refreshWinList();
};

$('btn-remove-selected').onclick = () => {
  if (!selectedWinId) return;
  wm.removeWindow(selectedWinId);
  selectedWinId = null;
  refreshWinEditor();
};

const PANEL_TITLES = {
  now_playing: 'now playing', lyrics: 'lyrics', status: 'pc status', socials: 'socials',
  message_bar: 'message bar', screen: 'screen', chat: 'chat', extra: 'extra',
  key_panel: 'key panel', spacer: 'log', pngtuber: 'pngtuber', alerts: 'alert', redeem_player: 'redeem',
  words: 'words', tts_transcript: 'tts', ad_warning: 'ad break', canvas: 'canvas', notepad: 'notes', latest: 'latest', status_text: 'status',
};

$('btn-add-window').onclick = () => {
  const panelType = $('add-panel-type').value;
  const id = nextIdFor(panelType);
  const isPopup = panelType === 'alerts' || panelType === 'redeem_player' || panelType === 'ad_warning' || panelType === 'canvas';
  const isTopmost = panelType === 'pngtuber';
  const win = {
    id, panel: panelType, title: PANEL_TITLES[panelType] || panelType,
    x: 60, y: 60, w: 320, h: 220,
    kind: isTopmost ? 'topmost' : (isPopup ? 'popup' : 'normal'),
    visible: !isPopup,
  };
  if (panelType === 'key_panel') win.opts = {
    shape: 'round', size: 48, gap: 8, glow: true, active_color: '#7ef7c6', inactive_color: '#1f2731', text_color: '#f5f7fa',
    keys: [{ key: 'w', label: 'W', color: '#7ef7c6', shape: 'round' }, { key: 'a', label: 'A', color: '#7ef7c6', shape: 'square' }, { key: 's', label: 'S', color: '#7ef7c6', shape: 'square' }, { key: 'd', label: 'D', color: '#7ef7c6', shape: 'square' }, { key: 'space', label: 'SPACE', color: '#8be9fd', shape: 'pill' }],
  };
  if (panelType === 'spacer') win.opts = { spacer_kind: 'bootlog' };
  if (panelType === 'words') win.opts = { wos_url: 'https://wos.gg/' };
  if (panelType === 'canvas') win.opts = { size: 100, bg_color: '#0a0c0d' };
  wm.addWindow(win);
  wm.select(id);
  refreshWinList();
};

$('btn-reset-layout').onclick = () => {
  wm.setLayout(DEFAULT_LAYOUT);
  send({ cmd: 'wm_layout_set', name: currentOverlay, layout: wm.getLayout() });
  selectedWinId = null;
  refreshWinEditor();
  refreshWinList();
  toast('layout reset');
};

// ── saved layout configs (e.g. "16:9" vs "4:3-retro") ──────────────────
function refreshLayoutConfigList(selectName) {
  fetch('/layouts-list').then(r => r.json()).then(data => {
    const sel = $('layout-config-select');
    sel.innerHTML = '<option value="">(unsaved / live)</option>';
    (data.names || []).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    });
    if (selectName) sel.value = selectName;
  }).catch(() => {});
}

$('btn-layout-save-as').onclick = () => {
  const name = prompt('save current layout as (e.g. "16:9", "4:3-retro"):');
  if (!name) return;
  fetch('/layout-save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, layout: wm.getLayout() }),
  }).then(r => r.json()).then(data => {
    if (data.ok) { toast('saved config: ' + data.name); refreshLayoutConfigList(data.name); }
    else toast('save failed: ' + (data.error || 'unknown error'));
  }).catch(() => toast('save failed'));
};

$('btn-layout-load').onclick = () => {
  const name = $('layout-config-select').value;
  if (!name) { toast('pick a saved config first'); return; }
  fetch('/layout-load?name=' + encodeURIComponent(name)).then(r => r.json()).then(data => {
    if (data.ok && Array.isArray(data.layout)) {
      wm.setLayout(data.layout);
      send({ cmd: 'wm_layout_set', name: currentOverlay, layout: wm.getLayout() });
      selectedWinId = null;
      refreshWinEditor();
      refreshWinList();
      toast('loaded config: ' + name);
    } else {
      toast('load failed: ' + (data.error || 'not found'));
    }
  }).catch(() => toast('load failed'));
};

$('btn-layout-delete').onclick = () => {
  const name = $('layout-config-select').value;
  if (!name) { toast('pick a saved config first'); return; }
  if (!confirm('delete saved config "' + name + '"?')) return;
  fetch('/layout-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json()).then(data => {
    if (data.ok) { toast('deleted ' + name); refreshLayoutConfigList(); }
    else toast('delete failed');
  }).catch(() => toast('delete failed'));
};

// ── websocket + existing panel wiring ────────────────────────────────
const STATUS_PRESETS = [
  ["starting soon", "starting"], ["be right back", "brb"], ["just chatting", "live"],
  ["playing: ", "live"], ["ending soon", "ending"], ["brb – technical", "brb"], ["offline", "live"],
];

function deriveSceneFromStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 'live';
  if (v.startsWith('playing:') || v.startsWith('playing')) return 'playing';
  if (v.startsWith('starting')) return 'starting';
  if (v.includes('brb') || v.includes('be right back') || v.includes('technical')) return 'brb';
  if (v.startsWith('ending')) return 'ending';
  return 'live';
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { $('ws-dot').classList.add('on'); };
  ws.onclose = () => { $('ws-dot').classList.remove('on'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state = msg.state;
      state.wm_layouts = state.wm_layouts || {};
      if (!state.wm_layouts.main) state.wm_layouts.main = state.wm_layout || [];
      if (!state.wm_layouts[currentOverlay]) currentOverlay = 'main';
      loadOverlay(currentOverlay);
      renderOverlaySelect();
      renderAll();
      fitStage();
      break;
    case 'wm_layout': {
      const nm = msg.name || 'main';
      state.wm_layouts = state.wm_layouts || {};
      state.wm_layouts[nm] = msg.layout;
      if (nm === currentOverlay) { wm.setLayout(msg.layout, { silent: true }); refreshWinList(); }
      renderOverlaySelect();
      break;
    }
    case 'wm_layout_deleted':
      delete (state.wm_layouts || {})[msg.name];
      if (currentOverlay === msg.name) loadOverlay('main');
      renderOverlaySelect();
      break;
    case 'notepad':
      state.notepads = state.notepads || {};
      state.notepads[msg.id] = msg.value;
      broadcastToAllPanels('notepad', msg);
      break;
    case 'latest':
      state.latest = msg.latest;
      broadcastToAllPanels('latest', msg.latest);
      break;
    case 'status': state.status = msg.value; renderStatus(); broadcastToAllPanels('status', { value: msg.value }); break;
    case 'scene': state.scene = msg.value; break;
    case 'pointer':
      state.pointer = msg.pointer;
      broadcastToAllPanels('pointer', msg.pointer);
      break;
    case 'message': state.message = msg.value; broadcastToAllPanels('message', { value: msg.value }); break;
    case 'stats': state.stats = msg; renderStats(); break;
    case 'tts_state': state.tts = msg.tts; renderTts(); broadcastToAllPanels('tts_state', msg.tts); break;
    case 'tts_reference_text_saved':
      $('tts-reference-status').textContent = `transcript saved: ${msg.path.split(/[\\/]/).pop()}`;
      break;
    case 'tts_reference_text_error':
      $('tts-reference-status').textContent = `transcript save failed: ${msg.error}`;
      break;
    case 'schedule': state.schedule = msg.schedule; renderSchedule(); break;
    case 'twitch_stats': state.twitch = msg.twitch; renderTwitch(); break;
    case 'obs_state': state.obs = msg.obs; renderObs(); break;
    case 'chat':
      state.chat = state.chat || [];
      state.chat.push(msg);
      if (state.chat.length > 20) state.chat.shift();
      renderChat();
      break;
    case 'commands_updated': state.commands = msg.commands; renderCommands(); break;
    case 'pngtuber': state.pngtuber = msg.pngtuber; renderMood(); break;
    case 'redeem_alert': toast(`redeem: ${msg.user} → ${msg.reward}`); break;
    case 'alert': toast(`${msg.alert}: ${msg.message}${msg.sub ? ' (' + msg.sub + ')' : ''}`); break;
    case 'follow': toast(`follow: ${msg.user}`); break;
    case 'raid': toast(`raid: ${msg.user} (${msg.viewers || 0})`); break;
    case 'ads_state': state.ads = msg.ads; renderAds(); broadcastToAllPanels('ads_state', msg.ads); break;
    case 'key_panel': state.key_panel = msg.key_panel; broadcastToAllPanels('key_panel', msg.key_panel); break;
    case 'words_state': state.words = msg.words; renderWords(); broadcastToAllPanels('words', msg.words); break;
    case 'canvas_state': state.canvas = msg.canvas; renderCanvas(); broadcastToAllPanels('canvas_state', msg.canvas); break;
    case 'canvas_pixel': broadcastToAllPanels('canvas_pixel', msg); break;
    case 'canvas_place_result': if (!msg.ok) toast(msg.message); break;
    case 'canvas_grant_result': toast(`${msg.user} now has ${msg.credits} credit(s)`); break;
  }
}

function broadcastToAllPanels(key, msg) {
  Panels.cacheMsg(key, msg);
  wm.forEachWindow(win => {
    const renderer = Panels[win.panel];
    const h = editorHandles.get(win.id);
    if (renderer && h && renderer.onState) {
      renderer.onState(h, key, msg, {}, wm, win.id);
    }
  });
}

function renderAll() {
  renderStatus(); renderStats(); renderTts(); renderSchedule();
  renderTwitch(); renderObs(); renderChat(); renderCommands(); renderMood();
  renderAds(); renderWords(); renderCanvas();
  if (state.key_panel) broadcastToAllPanels('key_panel', state.key_panel);
  if (state.pointer) broadcastToAllPanels('pointer', state.pointer);
  if (state.message !== undefined) broadcastToAllPanels('message', { value: state.message });
  Object.entries(state.notepads || {}).forEach(([id, value]) => broadcastToAllPanels('notepad', { id, value }));
  if (state.latest) broadcastToAllPanels('latest', state.latest);
  if (state.status !== undefined) broadcastToAllPanels('status', { value: state.status });
}

function pctClass(pct) { if (pct >= 85) return 'crit'; if (pct >= 65) return 'warn'; return ''; }
function parsePct(raw) { if (!raw) return 0; const m = String(raw).match(/([\d.]+)\s*%/); return m ? parseFloat(m[1]) : 0; }

function renderStatus() {}

function renderStats() {
  const s = state.stats || {};
  for (const key of ['cpu', 'mem', 'gpu']) {
    const raw = s[key] ?? '…';
    $('stat-' + key + '-val').textContent = raw;
    const pct = parsePct(raw);
    const fill = $('stat-' + key);
    fill.style.width = pct + '%';
    fill.className = 'stat-fill ' + pctClass(pct);
  }
  const wpmRaw = s.wpm ?? '…';
  $('stat-wpm-val').textContent = wpmRaw;
  const wpmNum = parseInt(wpmRaw) || 0;
  $('stat-wpm').style.width = Math.min(100, wpmNum / 120 * 100) + '%';
}

function renderTts() {
  const t = state.tts || {};
  const label = t.pending_engine
    ? `switching to ${t.pending_engine}`
    : (t.loading ? 'loading model' : (t.generating ? 'generating' : (t.speaking ? 'speaking' : (t.enabled ? 'ready' : 'disabled'))));
  $('tts-tag').textContent = label;
  $('tts-queue').textContent = t.queue_len ?? 0;

  function setOptions(select, options, selected) {
    const key = JSON.stringify(options);
    if (select.dataset.options !== key) {
      select.replaceChildren();
      options.forEach(([name, value]) => {
        const option = document.createElement('option');
        option.textContent = name;
        option.value = value;
        select.appendChild(option);
      });
      select.dataset.options = key;
    }
    if (document.activeElement !== select) select.value = selected;
  }

  setOptions(
    $('tts-engine-select'),
    (t.engines || [
      { id: 'chatterbox', name: 'Chatterbox Nano' },
      { id: 'kokoro', name: 'Kokoro' },
      { id: 'fish_s2_gguf', name: 'Fish S2 Pro (GGUF)' },
      { id: 'f5_tts', name: 'F5-TTS' }
    ])
      .map(engine => [engine.name || engine.id, engine.id]),
    t.pending_engine || t.engine || 'chatterbox'
  );
  setOptions(
    $('tts-voice-select'),
    [['default', ''], ...(t.voices || []).map(voice => [voice, voice])],
    $('tts-voice-select').value || ''
  );
  $('tts-reference-status').textContent = t.reference_text_error
    ? `transcript save failed: ${t.reference_text_error}`
    : t.reference_text_saved
      ? `transcript saved: ${t.reference_text_saved}.txt`
      : 'transcript auto-saves beside the selected voice';
  setOptions(
    $('tts-output-device-select'),
    [['System default', ''], ...(t.output_devices || []).map(device => [`${device.name} [${device.id}]`, String(device.id)])],
    t.output_device == null ? '' : String(t.output_device)
  );

  const elapsed = Number(t.generation_elapsed || 0).toFixed(1);
  const progress = t.generation_max_steps
    ? ` · ${t.generation_step || 0}/${t.generation_max_steps} tokens · ${Number(t.generation_tokens_per_second || 0).toFixed(1)} tok/s`
    : '';
  const previousGeneration = t.generation_elapsed
    ? ` · last generation: ${elapsed}s${t.generation_max_steps ? ` · ${t.generation_step || 0} tokens · ${Number(t.generation_tokens_per_second || 0).toFixed(1)} tok/s` : ''}`
    : '';
  $('tts-info').textContent = t.output_error
    ? `engine: ${t.engine_name || t.engine || '—'} · output: ${t.output_error}`
    : t.error
      ? `${t.engine_name || t.engine || 'TTS'} unavailable: ${t.error}`
      : `${t.generating ? `generating ${t.engine_name || t.engine} · ${elapsed}s${progress}` : `engine: ${t.engine_name || t.engine || '—'}`} · output: ${t.output_device_name || 'System default'}${t.generating ? '' : previousGeneration}`;
  const current = t.current || '';
  $('tts-current').textContent = current
    ? `current: ${current.length} chars · ${current.trim().split(/\s+/).filter(Boolean).length} words · ${current}`
    : '';
}

function renderSchedule() {
  const s = state.schedule || {};
  $('sw-scheduled').classList.toggle('on', !!s.scheduled_today);
  if (document.activeElement !== $('offline-text-input')) $('offline-text-input').value = s.offline_text || '';
}

function renderTwitch() {
  const t = state.twitch || {};
  $('kv-twitch').textContent = t.connected ? 'connected' : 'disconnected';
  $('kv-twitch').className = 'v ' + (t.connected ? 'on' : 'off');
  $('kv-followers').textContent = t.followers ?? '…';
  $('kv-subs').textContent = t.subscribers ?? '…';
  $('kv-viewers').textContent = t.viewers ?? '…';
}

function renderAds() {
  const a = state.ads || {};
  $('ads-tag').textContent = a.in_ad_break ? 'ad running' : (typeof a.seconds_until === 'number' ? `next in ~${Math.max(0, Math.round(a.seconds_until))}s` : 'idle');
  $('ads-next').textContent = a.next_ad_at || '…';
  $('sw-ads-enabled').classList.toggle('on', a.enabled !== false);
}
$('sw-ads-enabled').onclick = () => send({ cmd: 'ads_toggle' });
$('btn-ads-snooze').onclick = () => send({ cmd: 'ads_snooze' });

function renderWords() {
  const w = state.words || {};
  $('words-tag').textContent = w.active ? 'showing' : 'hidden';
}
$('btn-words-show').onclick = () => send({ cmd: 'words_set', value: true });
$('btn-words-hide').onclick = () => send({ cmd: 'words_set', value: false });
$('btn-wos-login').onclick = () => window.open('/wos-login', '_blank', 'noopener,noreferrer');

function renderCanvas() {
  const c = state.canvas || {};
  $('canvas-tag').textContent = c.visible ? 'showing' : 'hidden';
}
$('btn-canvas-show').onclick = () => send({ cmd: 'canvas_show' });
$('btn-canvas-clear').onclick = () => { if (confirm('clear the entire canvas?')) send({ cmd: 'canvas_clear' }); };
$('btn-canvas-grant').onclick = () => {
  const user = $('canvas-grant-user').value.trim();
  const amount = parseInt($('canvas-grant-amount').value, 10) || 0;
  if (!user || !amount) { toast('enter a username and amount'); return; }
  send({ cmd: 'canvas_grant', user, amount });
  $('canvas-grant-user').value = ''; $('canvas-grant-amount').value = '';
};

function renderObs() {
  const o = state.obs || {};
  $('obs-tag').textContent = o.connected ? (o.streaming ? 'streaming' : 'connected') : 'disconnected';
  const list = $('obs-scenes');
  list.innerHTML = '';
  (o.scenes || []).forEach(sceneName => {
    const div = document.createElement('div');
    div.className = 'scene-item' + (sceneName === o.current_scene ? ' active' : '');
    div.textContent = sceneName;
    div.onclick = () => send({ cmd: 'obs_set_scene', value: sceneName });
    list.appendChild(div);
  });
  if (!list.children.length) list.innerHTML = '<div class="empty" style="color:var(--text-dimmer);font-size:11px;">no scenes</div>';
  const audio = $('obs-audio');
  audio.innerHTML = '';
  (o.audio || []).forEach(a => {
    const name = typeof a === 'string' ? a : (a.inputName || a.name || 'input');
    const muted = typeof a === 'object' ? !!a.muted : false;
    const row = document.createElement('div');
    row.className = 'audio-item';
    row.innerHTML = `<span>${escapeHtml(name)}</span>`;
    const btn = document.createElement('button');
    btn.style.width = 'auto'; btn.style.marginTop = '0';
    btn.textContent = muted ? 'unmute' : 'mute';
    btn.onclick = () => send({ cmd: 'obs_toggle_mute', input: name });
    row.appendChild(btn);
    audio.appendChild(row);
  });
}

function renderChat() {
  const log = $('chatlog');
  const chat = state.chat || [];
  $('chat-count').textContent = chat.length;
  if (!chat.length) { log.innerHTML = '<div class="empty">waiting for chat…</div>'; return; }
  log.innerHTML = chat.map(c => `<div><span class="chat-user" style="color:${c.color || '#d8dee2'}">${escapeHtml(c.user)}</span>: <span class="chat-text">${escapeHtml(c.text)}</span></div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function renderCommands() {
  const cmds = state.commands || {};
  const tbody = $('cmd-tbody');
  tbody.innerHTML = '';
  Object.entries(cmds).forEach(([trigger, data]) => {
    const tr = document.createElement('tr');
    const isBuiltin = data.type === 'builtin';
    tr.innerHTML = `<td class="trig">${trigger}</td><td>${data.type || ''}</td><td>${data.enabled === false ? 'off' : 'on'}</td><td>${escapeHtml(data.response || data.description || '')}</td><td>${isBuiltin ? '' : '<span class="del">✕</span>'}</td>`;
    tr.onclick = (e) => {
      if (e.target.classList.contains('del')) { send({ cmd: 'command_delete', trigger }); return; }
      if (isBuiltin) { send({ cmd: 'command_set', trigger, data: { ...data, enabled: !(data.enabled !== false) } }); return; }
      $('cmd-trigger').value = trigger; $('cmd-response').value = data.response || '';
    };
    tbody.appendChild(tr);
  });
}

const MOODS = ['neutral', 'bored', 'sad', 'cheerful'];
function renderMood() {
  const grid = $('mood-grid');
  const current = (state.pngtuber || {}).mood || 'neutral';
  grid.innerHTML = '';
  MOODS.forEach(m => {
    const b = document.createElement('button');
    b.style.width = 'auto';
    b.textContent = m;
    if (m === current) b.classList.add('primary');
    b.onclick = () => send({ cmd: 'set_pngtuber_mood', value: m });
    grid.appendChild(b);
  });
}

function renderPresets() {
  const box = $('preset-chips');
  STATUS_PRESETS.forEach(([label]) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = label;
    chip.onclick = () => {
      if (label.endsWith(': ')) { $('status-input').value = label; $('status-input').focus(); }
      else {
        const scene = deriveSceneFromStatus(label);
        send({ cmd: 'status', value: label });
        send({ cmd: 'scene', value: scene });
      }
    };
    box.appendChild(chip);
  });
}

$('btn-status-send').onclick = () => {
  const v = $('status-input').value.trim();
  if (v) {
    const scene = deriveSceneFromStatus(v);
    send({ cmd: 'status', value: v });
    send({ cmd: 'scene', value: scene });
    $('status-input').value = '';
  }
};
$('status-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-status-send').click(); });
$('btn-message-send').onclick = () => { const v = $('message-input').value.trim(); if (v) { send({ cmd: 'message', value: v }); $('message-input').value = ''; } };
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-message-send').click(); });
$('btn-message-clear').onclick = () => send({ cmd: 'clear_message' });
$('sw-scheduled').onclick = () => send({ cmd: 'set_scheduled', value: !$('sw-scheduled').classList.contains('on') });
$('offline-text-input').addEventListener('change', () => send({ cmd: 'set_offline_text', value: $('offline-text-input').value }));
$('btn-tts-speak').onclick = () => { const v = $('tts-input').value.trim(); if (v) { send({ cmd: 'tts_say', value: v, voice: $('tts-voice-select').value || null, reference_text: $('tts-reference-text').value.trim() }); $('tts-input').value = ''; } };
$('tts-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-tts-speak').click(); });
$('tts-engine-select').onchange = () => send({ cmd: 'tts_set_engine', value: $('tts-engine-select').value });
$('tts-voice-select').onchange = () => {
  const voice = $('tts-voice-select').value;
  $('tts-reference-text').value = (state.tts?.reference_texts || {})[voice] || '';
};
$('tts-reference-text').addEventListener('input', () => {
  const voice = $('tts-voice-select').value;
  if (!voice) {
    $('tts-reference-status').textContent = 'select a voice to save its transcript';
    return;
  }
  const referenceText = $('tts-reference-text').value;
  clearTimeout(ttsReferenceSaveTimer);
  $('tts-reference-status').textContent = 'saving transcript…';
  ttsReferenceSaveTimer = setTimeout(() => {
    send({ cmd: 'tts_save_reference_text', voice, reference_text: referenceText });
  }, 700);
});
$('tts-output-device-select').onchange = () => send({ cmd: 'tts_set_output_device', value: $('tts-output-device-select').value });
$('btn-tts-skip').onclick = () => send({ cmd: 'tts_skip' });
$('btn-tts-clear').onclick = () => send({ cmd: 'tts_clear' });
$('btn-tts-toggle').onclick = () => send({ cmd: 'tts_toggle' });
$('btn-obs-stream').onclick = () => send({ cmd: 'obs_toggle_stream' });
$('btn-obs-record').onclick = () => send({ cmd: 'obs_toggle_record' });
$('btn-obs-refresh').onclick = () => send({ cmd: 'obs_refresh' });
$('btn-chat-send').onclick = () => { const v = $('chat-send-input').value.trim(); if (v) { send({ cmd: 'send_chat', value: v }); $('chat-send-input').value = ''; } };
$('chat-send-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-chat-send').click(); });
$('btn-cmd-save').onclick = () => {
  let trigger = $('cmd-trigger').value.trim().toLowerCase();
  const response = $('cmd-response').value.trim();
  if (!trigger) { toast('trigger is required'); return; }
  if (!trigger.startsWith('!')) trigger = '!' + trigger;
  send({ cmd: 'command_set', trigger, data: { type: 'custom', enabled: true, response } });
  toast('saved ' + trigger);
  $('cmd-trigger').value = ''; $('cmd-response').value = '';
};
$('btn-cmd-delete').onclick = () => {
  let trigger = $('cmd-trigger').value.trim().toLowerCase();
  if (!trigger) { toast('no trigger entered'); return; }
  if (!trigger.startsWith('!')) trigger = '!' + trigger;
  send({ cmd: 'command_delete', trigger });
  $('cmd-trigger').value = ''; $('cmd-response').value = '';
};
$('btn-cmd-clear').onclick = () => { $('cmd-trigger').value = ''; $('cmd-response').value = ''; };

setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
function refreshSpacerRowsFromDropdown() {
  const kind = $('ed-spacer-kind').value;
  const cursorKind = ['cursor', 'cursor-ripple', 'cursor-particles', 'cursor-radar'].includes(kind);
  $('ed-wireframe-shape-row').style.display = kind === 'wireframe' ? '' : 'none';
  $('ed-cursor-style-options').style.display = cursorKind ? '' : 'none';
  const isScroller = kind === 'scroller';
  $('ed-scroller-style-row').style.display = isScroller ? '' : 'none';
  $('ed-scroller-state-row').style.display = isScroller ? '' : 'none';
  $('ed-scroller-messages-row').style.display = isScroller ? '' : 'none';
}
$('ed-scroller-state').addEventListener('change', () => {
  if (!selectedWinId) return;
  const win = wm.getWindow(selectedWinId);
  if (!win) return;
  scrollerEditState = $('ed-scroller-state').value;
  const customMsgs = (win.opts && win.opts.spacer_scroller_messages && win.opts.spacer_scroller_messages[scrollerEditState]) || [];
  $('ed-scroller-messages').value = customMsgs.join('\n');
});

$('ed-spacer-kind').addEventListener('change', () => {
  $('ed-spacer-color').value = SPACER_COLOR_DEFAULTS[$('ed-spacer-kind').value] || '#00ff66';
  setColorGradient('ed-spacer-color', null);
  refreshSpacerRowsFromDropdown();
  renderSpacerPicker();
});
[
  ['ed-cursor-spacing', ' px'],
  ['ed-cursor-dot-size', ' px'],
  ['ed-cursor-spacing-opacity', '%'],
  ['ed-cursor-marker-size', ' px'],
  ['ed-cursor-radius', ' px'],
  ['ed-cursor-strength', '%'],
  ['ed-cursor-speed', '%'],
].forEach(([id, suffix]) => {
  $(id).addEventListener('input', () => { $(`${id}-value`).textContent = `${$(id).value}${suffix}`; });
});
function loadOverlay(name) {
  currentOverlay = name;
  const l = (state.wm_layouts || {})[name];
  selectedWinId = null;
  refreshWinEditor();
  wm.setLayout(l && l.length ? l : DEFAULT_LAYOUT, { silent: true });
  refreshWinList();
  $('overlay-url').textContent = `obs url: http://${location.host}/overlay?layout=${name}`;
}
function renderOverlaySelect() {
  const names = Object.keys(state.wm_layouts || {}).filter(n => !n.startsWith('__'));
  if (!names.includes('main')) names.unshift('main');
  $('overlay-select').innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
  $('overlay-select').value = currentOverlay;
}
$('overlay-select').onchange = () => loadOverlay($('overlay-select').value);
$('btn-overlay-new').onclick = () => {
  const n = (prompt('overlay name (e.g. brb):') || '').trim().replace(/[^\w\-]/g, '_').slice(0, 40);
  if (!n || (state.wm_layouts || {})[n]) return;
  state.wm_layouts[n] = wm.getLayout();
  send({ cmd: 'wm_layout_set', name: n, layout: state.wm_layouts[n] });
  loadOverlay(n);
  renderOverlaySelect();
};
$('btn-overlay-del').onclick = () => {
  if (currentOverlay === 'main') { toast("can't delete main"); return; }
  if (!confirm('delete overlay "' + currentOverlay + '"?')) return;
  const n = currentOverlay;
  delete state.wm_layouts[n];
  send({ cmd: 'wm_layout_delete', name: n });
  loadOverlay('main');
  renderOverlaySelect();
};

function bulkOpts(fn) {
  wm.getLayout().forEach(w => {
    const o = { ...(w.opts || {}) };
    if (fn(w, o) !== false) wm.updateWindow(w.id, { opts: o }, { silent: true });
  });
  const layout = wm.getLayout();
  state.wm_layouts[currentOverlay] = layout;
  send({ cmd: 'wm_layout_set', name: currentOverlay, layout });
  refreshWinEditor();
  toast('applied');
}
$('bulk-border-apply').onclick = () => bulkOpts((w, o) => {
  const m = $('bulk-border-mode').value;
  if (m === 'default') { delete o.border_mode; delete o.border_color; delete o.border_color2; delete o.border_stops; return; }
  const stops = colorStops($('bulk-border-stops'));
  o.border_mode = m; o.border_color = stops[0]; o.border_color2 = stops[1]; o.border_stops = stops;
});
$('bulk-bg-apply').onclick = () => bulkOpts((w, o) => {
  const stops = selectedColorGradient('bulk-bg');
  o.bg_color = stops ? stops[0] : $('bulk-bg').value;
  if (stops) o.bg_color_stops = stops;
  else delete o.bg_color_stops;
});
$('bulk-text-apply').onclick = () => bulkOpts((w, o) => {
  const stops = selectedColorGradient('bulk-text');
  o.text_color = stops ? stops[0] : $('bulk-text').value;
  if (stops) o.text_color_stops = stops;
  else delete o.text_color_stops;
});
$('bulk-spacer-apply').onclick = () => bulkOpts((w, o) => {
  if (w.panel !== 'spacer') return false;
  const stops = selectedColorGradient('bulk-spacer');
  o.spacer_color = stops ? stops[0] : $('bulk-spacer').value;
  if (stops) o.spacer_color_stops = stops;
  else delete o.spacer_color_stops;
});
$('bulk-spacer-bg-apply').onclick = () => bulkOpts((w, o) => {
  if (w.panel !== 'spacer') return false;
  o.spacer_bg_color = $('bulk-spacer-bg').value || '#000000';
});

let npTimer = null;
$('ed-notepad-text').addEventListener('input', () => {
  if (!selectedWinId) return;
  const id = selectedWinId, value = $('ed-notepad-text').value;
  state.notepads = state.notepads || {};
  state.notepads[id] = value;
  broadcastToAllPanels('notepad', { id, value });
  clearTimeout(npTimer);
  npTimer = setTimeout(() => send({ cmd: 'notepad_set', id, value }), 150);
});

renderPresets();
refreshLayoutConfigList();
connect();
window.addEventListener('resize', fitStage);
setTimeout(fitStage, 50);