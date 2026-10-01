import pathlib, sys

p = pathlib.Path(__file__).resolve().parent / 'overlay' / 'panels.js'
raw = p.read_bytes().decode('utf-8')
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')

FX = r'''  let fxStyled = false;
  function ensureFxStyles() {
    if (fxStyled) return;
    fxStyled = true;
    const st = document.createElement('style');
    st.textContent = `
@keyframes fxwave{0%,100%{transform:translateY(-.22em)}50%{transform:translateY(.22em)}}
@keyframes fxorbit{0%{transform:translate(.08em,0)}25%{transform:translate(0,.08em)}50%{transform:translate(-.08em,0)}75%{transform:translate(0,-.08em)}100%{transform:translate(.08em,0)}}
@keyframes fxshake{0%{transform:translate(.04em,.03em) rotate(2deg)}20%{transform:translate(-.05em,.02em) rotate(-3deg)}40%{transform:translate(.03em,-.05em) rotate(1deg)}60%{transform:translate(-.03em,-.03em) rotate(-2deg)}80%{transform:translate(.05em,.04em) rotate(3deg)}100%{transform:translate(0,0)}}
@keyframes fxhop{0%,100%{transform:translateY(0) scaleY(.9)}40%{transform:translateY(-.45em) scaleY(1.1)}70%{transform:translateY(0) scaleY(.85)}}
@keyframes fxgrow{0%,100%{transform:scale(1)}50%{transform:scale(1.4)}}
@keyframes fxgrad{to{background-position-x:4em}}`;
    document.head.appendChild(st);
  }
  function fxChars(html, anim, dur, step, timing) {
    let i = 0;
    return html.replace(/(<[^>]+>)|(&[#\w]+;|[\s\S])/g, (m, tag, ch) => {
      if (tag) return tag;
      const d = (-(i++) * step).toFixed(2);
      return `<span style="display:inline-block;white-space:pre;animation:${anim} ${dur}s ${timing} ${d}s infinite">${ch}</span>`;
    });
  }
  function fx(s) {
    ensureFxStyles();
    const R = (re, f) => { s = s.replace(re, f); };
    R(/\*\^\*\^(.+?)\*\^\*\^/g, (m, t) => `<span style="font-weight:900;font-size:1.25em">${t}</span>`);
    R(/%\$(.+?)\$%/g, (m, t) => `<span style="font-family:monospace;letter-spacing:.06em;text-rendering:optimizeSpeed;-webkit-font-smoothing:none;text-shadow:1px 0 currentColor,0 1px currentColor">${t}</span>`);
    R(/\$!(.+?)!\$/g, (m, t) => `<span style="text-shadow:0 0 3px currentColor,0 0 8px currentColor,0 0 16px currentColor,0 0 28px currentColor">${t}</span>`);
    R(/##([0-9a-fA-F]{3,6})\|([0-9a-fA-F]{3,6}):(.+?)##/g, (m, a, b, t) => `<span style="background-image:linear-gradient(90deg,#${a},#${b},#${a});background-size:4em auto;background-repeat:repeat-x;-webkit-background-clip:text;background-clip:text;color:transparent;animation:fxgrad 2s linear infinite">${t}</span>`);
    R(/##([0-9a-fA-F]{3,6}):(.+?)##/g, (m, c, t) => `<span style="color:#${c}">${t}</span>`);
    R(/!\*(.+?)\*!/g, (m, t) => fxChars(t, 'fxshake', 0.3, 0.07, 'steps(1)'));
    R(/&gt;\*(.+?)\*&lt;/g, (m, t) => fxChars(t, 'fxgrow', 1.2, 0.1, 'ease-in-out'));
    R(/\^&gt;(.+?)&lt;\^/g, (m, t) => fxChars(t, 'fxhop', 0.9, 0.09, 'ease-in-out'));
    R(/-#(.+?)#-/g, (m, t) => fxChars(t, 'fxwave', 1.6, 0.12, 'ease-in-out'));
    R(/\(#(.+?)#\)/g, (m, t) => fxChars(t, 'fxorbit', 0.9, 0.13, 'linear'));
    R(/%(.+?)%/g, (m, t) => `<span style="font-size:.7em;vertical-align:super">${t}</span>`);
    return s;
  }
  function rich(t) { return mdInline(escapeHtml(t)); }

'''

pairs = [
    ('  function mdInline(s) {\n    return s.replace(', FX + '  function mdInline(s) {\n    return fx(s).replace('),
    ('e.match(/^&gt;\\s?(.*)$/)', 'e.match(/^&gt;\\s(.*)$/)'),
    ("h.line.textContent = msg && msg.value ? String(msg.value) : '';", "h.line.innerHTML = msg && msg.value ? rich(msg.value) : '';"),
]
for a, b in pairs:
    if s.count(a) != 1:
        sys.exit(f'expected 1 match, got {s.count(a)}: {a[:70]!r}')
    s = s.replace(a, b)

a = '.map(l => `<span class="line">${escapeHtml(l)}</span>`)'
if s.count(a) != 2:
    sys.exit(f'socials: expected 2 matches, got {s.count(a)}')
s = s.replace(a, '.map(l => `<span class="line">${rich(l)}</span>`)')

p.write_bytes((s.replace('\n', '\r\n') if crlf else s).encode('utf-8'))
print('patched overlay/panels.js')
