// lib/panel.js —— 管理页（内联 HTML + CSS + JS，无构建步骤）
// 客户端渲染全部用 createElement + textContent，配置里的名字带尖括号也不会出问题。

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#0b0e14;--bg-top:#080a10;--panel:#12161f;--card:#161b26;--line:#232a38;--line2:#2f3949;
  --text:#dfe6f0;--muted:#7d8799;--dim:#5a6474;
  --green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bg-top);border-bottom:1px solid var(--line)}
.brand{font-size:15px;font-weight:600;letter-spacing:.01em}
.brand small{color:var(--dim);font-weight:400;font-size:11px;margin-left:6px}
.spacer{flex:1}
input,select,textarea{background:#0e1219;border:1px solid var(--line2);color:var(--text);border-radius:6px;padding:6px 9px;font:inherit;font-size:12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:#3d6ea8}
button{font:inherit;font-size:12px;background:transparent;border:1px solid var(--line2);color:#9aa6b8;border-radius:6px;padding:5px 11px;cursor:pointer;transition:.12s}
button:hover{background:#1b2230;color:var(--text);border-color:#3a4557}
button:disabled{opacity:.4;cursor:not-allowed}
button.primary{color:#7ee787;border-color:#2b5c34}
button.primary:hover{background:#132a19}
button.danger{color:#ff7b72;border-color:#5c2b28}
button.danger:hover{background:#2a1413}
button.ghost{border-color:transparent;color:var(--dim)}
button.ghost:hover{border-color:var(--line2)}
#grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:20px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:border-color .12s,background .12s}
.card:hover{border-color:#39445a;background:#182030}
@keyframes cardIn{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:none}}
.card.enter{animation:cardIn .34s cubic-bezier(.2,.8,.2,1) backwards}
.card.add{justify-content:center;align-items:center;border-style:dashed;color:var(--dim);font-size:13px;min-height:104px}
.card.add:hover{color:var(--text)}
.row{display:flex;align-items:center;gap:8px;min-width:0}
.name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.tag{font-size:10px;color:var(--dim);border:1px solid var(--line2);border-radius:4px;padding:0 5px;line-height:16px;flex:none}
.meta{font-family:var(--mono);font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acts{display:flex;gap:6px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dim)}
.dot.running{background:var(--green);box-shadow:0 0 0 3px rgba(63,185,80,.15)}
.dot.starting,.dot.stopping{background:var(--amber);animation:pulse 1.1s ease-in-out infinite}
.dot.crashed,.dot.failed{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.empty{padding:60px 20px;text-align:center;color:var(--dim);font-size:13px}
#overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:.18s;z-index:40}
#overlay.on{opacity:1;pointer-events:auto}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(680px,92vw);background:var(--panel);border-left:1px solid var(--line2);transform:translateX(101%);transition:transform .2s ease;z-index:50;display:flex;flex-direction:column}
#drawer.on{transform:translateX(0)}
.dhead{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.dbody{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:12px;padding:12px 16px 16px;min-height:0}
@media(max-width:720px){.dbody{grid-template-columns:1fr}}
#log{background:#070a0f;border:1px solid #1a2130;border-radius:8px;padding:10px 12px;font-family:var(--mono);font-size:11.5px;line-height:1.75;overflow:auto;min-height:0;white-space:pre-wrap;word-break:break-word}
#log .ln{display:block}
#log .ts{color:#48515f;margin-right:8px;user-select:none}
#log .err{color:#ff9c96}
#log .warn{color:#e3b341}
#log .sys{color:#6e7b8f;font-style:italic}
.side{display:flex;flex-direction:column;gap:12px;overflow:auto}
.side h4{margin:0;font-size:11px;font-weight:500;color:var(--dim);letter-spacing:.04em}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:11px;color:var(--muted)}
.field input{font-family:var(--mono);font-size:12px;width:100%}
#modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:60;padding:20px}
#modal.on{display:flex}
.mbox{background:var(--panel);border:1px solid var(--line2);border-radius:12px;width:min(560px,100%);max-height:88vh;overflow:auto;padding:20px}
.mbox h3{margin:0 0 16px;font-size:14px;font-weight:500}
.mrow{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center;margin-bottom:10px}
.mrow>label{font-size:12px;color:var(--muted)}
.mrow input,.mrow select,.mrow textarea{width:100%}
.mrow textarea{font-family:var(--mono);font-size:12px;resize:vertical;min-height:56px}
.mfoot{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.hint{font-size:11px;color:var(--dim);margin-top:-4px;margin-bottom:10px;line-height:1.5}
.more{margin-left:auto;padding:3px 8px;line-height:1;font-size:14px;color:var(--dim);border-color:transparent}
.more:hover{color:var(--text);border-color:var(--line2)}
#menu{position:fixed;z-index:70;min-width:158px;padding:4px;background:var(--card);border:1px solid var(--line2);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.45);display:none}
#menu.on{display:block}
#menu button{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--text);padding:7px 10px;border-radius:5px;font-size:12px}
#menu button:hover{background:#212a39}
#menu button.danger{color:#ff7b72}
#menu button.danger:hover{background:#2a1413}
#menu hr{border:none;border-top:1px solid var(--line);margin:4px 2px}
#settings{position:fixed;top:0;right:0;bottom:0;width:min(680px,94vw);background:var(--panel);border-left:1px solid var(--line2);transform:translateX(101%);transition:transform .28s cubic-bezier(.22,1,.36,1);z-index:55;display:flex;flex-direction:column}
#settings.on{transform:translateX(0)}
.swrap{flex:1;display:flex;min-height:0}
.snav{width:154px;flex:none;border-right:1px solid var(--line);padding:10px 8px;display:flex;flex-direction:column;gap:2px}
.snav button{border:none;background:transparent;text-align:left;padding:8px 11px;border-radius:6px;color:var(--muted);font-size:12.5px;transition:background .12s,color .12s}
.snav button:hover{background:#161d29;color:var(--text);border-color:transparent}
.snav button.on{background:#1b2534;color:#cfe3ff}
.sbody{flex:1;overflow:auto;padding:18px 20px;min-width:0}
.pane{display:none}
.pane.on{display:block;animation:paneIn .26s cubic-bezier(.2,.8,.2,1)}
@keyframes paneIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.pane section{margin-bottom:22px}
.pane h4{margin:0 0 10px;font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.04em}
.opt{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer}
.opt:hover{border-color:var(--line2);background:#141a24}
.opt input{margin:2px 0 0;flex:none}
.opt .txt{display:flex;flex-direction:column;gap:2px}
.opt .txt b{font-size:12px;font-weight:500}
.opt .txt span{font-size:11px;color:var(--dim);line-height:1.5}
.badge{font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--line2);color:var(--dim)}
.badge.on{color:#7ee787;border-color:#2b5c34;background:#132a19}
.kv{display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid var(--line);font-size:12px}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--dim);flex:none}
.kv .v{color:var(--text);font-family:var(--mono);font-size:11px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kv .v.path{color:#8ab4f8;cursor:pointer}
.kv .v.path:hover{text-decoration:underline}
.docklist{display:flex;flex-direction:column;gap:6px}
.ditem{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:7px;font-size:12px;transition:opacity .12s}
.ditem .idx{font-family:var(--mono);font-size:10px;color:var(--dim);width:14px;flex:none}
.ditem .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ditem .mv{border:none;background:transparent;color:var(--dim);padding:2px 5px;border-radius:4px;font-size:12px;line-height:1}
.ditem .mv:hover{background:#222b3a;color:var(--text);border-color:transparent}
.ditem.off{opacity:.4}

/* ---- 无边框窗口：自绘标题栏 / 窗口按钮 / 缩放热区 ---- */
body.shell #titlebar{user-select:none;-webkit-user-select:none}
.wctl{display:none;align-items:center;gap:1px;margin-left:2px;padding-left:10px;border-left:1px solid var(--line)}
body.shell .wctl{display:flex}
.wctl button{width:30px;height:24px;padding:0;border:none;background:transparent;color:var(--muted);font-size:11px;line-height:1;border-radius:5px;display:flex;align-items:center;justify-content:center}
.wctl button:hover{background:#1b2230;color:var(--text);border-color:transparent}
.wctl button[data-w=close]:hover{background:#c93c37;color:#fff}

/* 边框内化：整页一圈 1px 内描边。inset 阴影不占布局、不吃点击，
   比 border 更适合"窗口无边框、但视觉上要有边界"这个诉求。 */
body::after{content:"";position:fixed;inset:0;z-index:200;pointer-events:none;box-shadow:inset 0 0 0 1px var(--line2)}

#rz{display:none}
body.shell #rz{display:block}
#rz i{position:fixed;z-index:150;display:block}
#rz i[data-d=n]{left:9px;right:9px;top:0;height:4px;cursor:ns-resize}
#rz i[data-d=s]{left:9px;right:9px;bottom:0;height:4px;cursor:ns-resize}
#rz i[data-d=w]{top:9px;bottom:9px;left:0;width:4px;cursor:ew-resize}
#rz i[data-d=e]{top:9px;bottom:9px;right:0;width:4px;cursor:ew-resize}
#rz i[data-d=nw]{left:0;top:0;width:10px;height:10px;cursor:nwse-resize}
#rz i[data-d=ne]{right:0;top:0;width:10px;height:10px;cursor:nesw-resize}
#rz i[data-d=sw]{left:0;bottom:0;width:10px;height:10px;cursor:nesw-resize}
#rz i[data-d=se]{right:0;bottom:0;width:10px;height:10px;cursor:nwse-resize}
`;

const CLIENT_JS = String.raw`
(function () {
  var state = { items: [], hub: null };
  var cards = new Map();
  var drawer = { id: null, follow: true, lastSeq: 0 };
  var editing = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function $(s) { return document.querySelector(s); }

  function fmtUptime(ms) {
    if (!ms || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h' + (m % 60) + 'm';
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function baseName(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function statusOf(item) {
    var rt = item.runtime;
    if (!rt) return { cls: '', text: '静态' };
    var map = {
      running: { cls: 'running', text: '运行中' },
      starting: { cls: 'starting', text: '启动中' },
      stopping: { cls: 'stopping', text: '停止中' },
      stopped: { cls: '', text: '已停止' },
      crashed: { cls: 'crashed', text: '已崩溃' },
      failed: { cls: 'failed', text: '失败' },
      idle: { cls: '', text: '待运行' },
      done: { cls: '', text: '完成' }
    };
    return map[rt.status] || { cls: '', text: rt.status };
  }

  function metaOf(item) {
    var rt = item.runtime || {};
    if (item.kind === 'service') {
      var host = item.port ? (item.url ? item.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '127.0.0.1:' + item.port) : (item.cmd || '');
      var tail = '';
      if (rt.status === 'running' && rt.uptimeMs) tail = ' · ' + fmtUptime(rt.uptimeMs);
      else if (rt.status === 'running' && rt.external) tail = ' · 外部';
      else if (rt.exitCode != null) tail = ' · exit ' + rt.exitCode;
      return host + tail;
    }
    if (item.kind === 'script') {
      var s = baseName(item.path);
      if (rt.status === 'running') s += ' · 运行中';
      else if (rt.exitCode != null) s += ' · exit ' + rt.exitCode;
      return s;
    }
    return '/s/' + item.id + '/';
  }

  function actionsOf(item) {
    var rt = item.runtime || {};
    var out = [];
    if (item.kind === 'service') {
      if (rt.status === 'running' || rt.status === 'starting') out.push(['stop', '停止', 'danger']);
      else out.push(['start', '启动', 'primary']);
      if (item.url || rt.url) out.push(['open', '打开页面', '']);
    } else if (item.kind === 'script') {
      if (rt.status === 'running') out.push(['stop', '停止', 'danger']);
      else out.push(['run', '运行', 'primary']);
    } else {
      out.push(['open', '打开页面', 'primary']);
    }
    return out;
  }

  function buildCard(item) {
    var c = el('div', 'card');
    c.dataset.id = item.id;
    // 入场动画只给新建的卡片，复用的一律不重播
    c.classList.add('enter');
    c.style.animationDelay = (cards.size * 28) + 'ms';
    c.appendChild(el('div', 'row')).appendChild(el('span', 'dot'));
    c.firstChild.appendChild(el('span', 'name'));
    c.firstChild.appendChild(el('span', 'tag'));
    c.appendChild(el('div', 'meta'));
    c.appendChild(el('div', 'acts'));
    updateCard(c, item);
    return c;
  }

  function updateCard(c, item) {
    var st = statusOf(item);
    var row = c.children[0];
    var dot = row.children[0];
    dot.className = 'dot ' + st.cls;
    row.children[1].textContent = item.name;
    row.children[2].textContent = { service: '服务', script: '脚本', page: '页面' }[item.kind] || item.kind;
    c.children[1].textContent = metaOf(item);

    var acts = c.children[2];
    acts.textContent = '';
    actionsOf(item).forEach(function (a) {
      var b = el('button', a[2], a[1]);
      b.dataset.act = a[0];
      acts.appendChild(b);
    });
    var more = el('button', 'more', '⋮');
    more.dataset.act = 'menu';
    more.title = '更多';
    acts.appendChild(more);

    c.dataset.kind = item.kind;
    c.dataset.url = item.url || '';
  }

  function render() {
    var grid = $('#grid');
    var seen = new Set();
    state.items.forEach(function (item) {
      seen.add(item.id);
      var c = cards.get(item.id);
      if (!c) {
        c = buildCard(item);
        cards.set(item.id, c);
        grid.appendChild(c);
      } else {
        updateCard(c, item);
      }
    });
    cards.forEach(function (c, id) {
      if (!seen.has(id)) { c.remove(); cards.delete(id); }
    });
    if (!state.items.length) {
      if (!$('#empty')) grid.appendChild(el('div', 'empty', '还没有配置任何项。点右下角「+ 添加」或直接改 hub.config.json。')).id = 'empty';
    } else {
      var e = $('#empty');
      if (e) e.remove();
    }
    var addBtn = $('#addCard');
    if (addBtn) {
      if (!addBtn.dataset.animated) {
        addBtn.dataset.animated = '1';
        addBtn.classList.add('enter');
        addBtn.style.animationDelay = (cards.size * 28) + 'ms';
      }
      grid.appendChild(addBtn);
    }
  }

  // ---- 列数切换 ----
  // CSS media query 改列数时拿不到"重排前"的位置，做不了 FLIP，卡片会瞬跳。
  // 所以列数改由 JS 控制：宽度跨阈值时先记录每张卡的 rect，改完 gridTemplateColumns
  // 再用 transform 反向偏移、下一帧过渡回 0。
  var cols = 3;

  function targetCols() {
    var w = window.innerWidth;
    if (w <= 640) return 1;
    if (w <= 980) return 2;
    return 3;
  }

  function setCols(n) {
    cols = n;
    $('#grid').style.gridTemplateColumns = 'repeat(' + n + ',minmax(0,1fr))';
  }

  function flipTo(n) {
    if (n === cols) return;
    var nodes = [];
    cards.forEach(function (c) { nodes.push(c); });
    var addBtn = $('#addCard');
    if (addBtn) nodes.push(addBtn);
    if (!nodes.length) { setCols(n); return; }

    var before = nodes.map(function (c) { return c.getBoundingClientRect(); });
    setCols(n);

    nodes.forEach(function (c, i) {
      var a = before[i];
      var b = c.getBoundingClientRect();
      var dx = a.left - b.left;
      var dy = a.top - b.top;
      if (!dx && !dy) return;
      c.style.animation = 'none'; // 入场动画会跟 FLIP 抢 transform
      c.style.transition = 'none';
      c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    });

    requestAnimationFrame(function () {
      nodes.forEach(function (c) {
        c.style.transition = 'transform .38s cubic-bezier(.2,.8,.2,1)';
        c.style.transform = '';
      });
      setTimeout(function () {
        nodes.forEach(function (c) { c.style.transition = ''; });
      }, 420);
    });
  }

  var resizeRaf = 0;
  window.addEventListener('resize', function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () {
      resizeRaf = 0;
      flipTo(targetCols());
    });
  });

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  async function loadState() {
    var d = await api('/api/state');
    state.items = d.items || [];
    state.hub = d.hub;
    state.settings = d.settings || {};
    render();
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function appendLog(entry) {
    var log = $('#log');
    if (!log) return;
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    var line = el('span', 'ln');
    line.appendChild(el('span', 'ts', fmtTime(entry.ts)));
    var body = el('span', entry.stream === 'err' ? 'err' : entry.stream === 'sys' ? 'sys' : '');
    var text = entry.text || '';
    if (entry.stream === 'out' && /\b(ERROR|error|Error|FATAL|fail)/.test(text)) body.className = 'err';
    else if (entry.stream === 'out' && /\b(WARN|warn|Warning)/.test(text)) body.className = 'warn';
    body.textContent = text;
    line.appendChild(body);
    log.appendChild(line);
    if (drawer.follow && atBottom) log.scrollTop = log.scrollHeight;
    drawer.lastSeq = Math.max(drawer.lastSeq, entry.seq || 0);
  }

  function setDrawerHeader(item) {
    var st = statusOf(item);
    var head = $('#dhead');
    head.textContent = '';
    var dot = el('span', 'dot ' + st.cls);
    head.appendChild(dot);
    head.appendChild(el('span', 'name', item.name));
    head.appendChild(el('span', 'meta', st.text));
    var meta = el('span', 'meta', metaOf(item));
    head.appendChild(meta);
    head.appendChild(el('div', 'spacer'));
    if (item.kind !== 'page') {
      var b = el('button', st.cls === 'running' || st.cls === 'starting' ? 'danger' : 'primary',
        st.cls === 'running' || st.cls === 'starting' ? '停止' : (item.kind === 'script' ? '运行' : '启动'));
      b.dataset.act = st.cls === 'running' || st.cls === 'starting' ? 'stop' : (item.kind === 'script' ? 'run' : 'start');
      b.dataset.id = item.id;
      head.appendChild(b);
    }
    if (item.url || (item.runtime && item.runtime.url) || item.kind === 'page') {
      var o = el('button', '', '打开页面');
      o.dataset.act = 'open';
      o.dataset.id = item.id;
      head.appendChild(o);
    }
    var clr = el('button', 'ghost', '清空');
    clr.dataset.act = 'clear';
    clr.dataset.id = item.id;
    head.appendChild(clr);
    var x = el('button', 'ghost', '✕');
    x.dataset.act = 'close';
    head.appendChild(x);
  }

  function renderSide(item) {
    var side = $('#dside');
    side.textContent = '';
    if (item.kind !== 'script') {
      side.appendChild(el('h4', '', '信息'));
      [['类型', item.kind], ['ID', item.id], ['路径', item.dir || item.cwd || item.path || '']].forEach(function (p) {
        var f = el('div', 'field');
        f.appendChild(el('label', '', p[0]));
        var v = el('div', 'meta', p[1] || '—');
        v.style.whiteSpace = 'normal';
        v.style.wordBreak = 'break-all';
        f.appendChild(v);
        side.appendChild(f);
      });
      return;
    }
    side.appendChild(el('h4', '', '启动参数'));
    if (!item.params || !item.params.length) {
      side.appendChild(el('div', 'meta', '这个脚本没有可配参数'));
    } else {
      item.params.forEach(function (p) {
        var f = el('div', 'field');
        f.appendChild(el('label', '', p.name + (p.flag ? '  ' + p.flag : '')));
        var inp = el('input');
        if (p.type === 'boolean') { inp.type = 'checkbox'; inp.checked = !!p.default; }
        else { inp.type = p.type === 'number' ? 'number' : 'text'; inp.value = p.default != null ? p.default : ''; }
        inp.dataset.param = p.name;
        inp.dataset.ptype = p.type || 'text';
        f.appendChild(inp);
        side.appendChild(f);
      });
    }
    var run = el('button', 'primary', '运行');
    run.dataset.act = 'run';
    run.dataset.id = item.id;
    run.style.marginTop = '4px';
    side.appendChild(run);
  }

  async function openDrawer(id) {
    var item = findItem(id);
    if (!item) return;
    drawer.id = id;
    drawer.lastSeq = 0;
    drawer.follow = true;
    setDrawerHeader(item);
    renderSide(item);
    var log = $('#log');
    log.textContent = '';
    $('#drawer').classList.add('on');
    $('#overlay').classList.add('on');
    try {
      var d = await api('/api/items/' + encodeURIComponent(id) + '/logs?since=0');
      (d.lines || []).forEach(appendLog);
      log.scrollTop = log.scrollHeight;
    } catch (e) { /* ignore */ }
  }

  function closeDrawer() {
    drawer.id = null;
    $('#drawer').classList.remove('on');
    $('#overlay').classList.remove('on');
  }

  async function doAction(id, act, extra) {
    var item = findItem(id);
    if (!item) return;

    if (act === 'logs') { openDrawer(id); return; }
    if (act === 'edit') { openEditor(item); return; }
    if (act === 'close') { closeDrawer(); return; }
    if (act === 'delete') {
      confirmDialog({
        title: '删除「' + item.name + '」',
        text: '正在运行的话会先停掉再删。配置里的这一项会被移除。',
        okText: '删除',
        danger: true,
        onOk: async function () {
          await api('/api/items/' + id, { method: 'DELETE' });
          if (drawer.id === id) closeDrawer();
          await loadState();
        },
      });
      return;
    }

    try {
      if (act === 'start') {
        await api('/api/items/' + id + '/start', { method: 'POST' });
      } else if (act === 'stop') {
        await api('/api/items/' + id + '/stop', { method: 'POST' });
      } else if (act === 'run') {
        var values = {};
        document.querySelectorAll('#dside [data-param]').forEach(function (inp) {
          values[inp.dataset.param] = inp.dataset.ptype === 'boolean' ? inp.checked : inp.value;
        });
        Object.assign(values, extra || {});
        await api('/api/items/' + id + '/run', { method: 'POST', body: JSON.stringify({ values: values }) });
        if (drawer.id !== id) openDrawer(id);
      } else if (act === 'open') {
        // runtime.url 是从输出里抓到的真实地址（可能带一次性 token），优先用它
        var url = (item.runtime && item.runtime.url) || item.url || ('/s/' + id + '/');
        if (url.charAt(0) === '/') url = location.origin + url;
        await api('/api/open-window', { method: 'POST', body: JSON.stringify({ url: url }) });
      } else if (act === 'reveal') {
        await api('/api/items/' + id + '/reveal', { method: 'POST' });
      } else if (act === 'clear') {
        await api('/api/items/' + id + '/clear-logs', { method: 'POST' });
        $('#log').textContent = '';
      }
    } catch (e) {
      toast(e.message);
    }
    await loadState();
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 3200);
  }

  function connect() {
    var es = new EventSource('/api/events');
    es.addEventListener('state', function (ev) {
      var d = JSON.parse(ev.data);
      var item = findItem(d.id);
      if (item) {
        item.runtime = d;
        var c = cards.get(d.id);
        if (c) updateCard(c, item);
        if (drawer.id === d.id) setDrawerHeader(item);
      }
    });
    es.addEventListener('log', function (ev) {
      var d = JSON.parse(ev.data);
      if (drawer.id === d.id) appendLog(d);
    });
    es.addEventListener('cleared', function (ev) {
      var d = JSON.parse(ev.data);
      if (drawer.id === d.id) { $('#log').textContent = ''; drawer.lastSeq = 0; }
    });
    es.addEventListener('config', function () { loadState(); });
    es.addEventListener('config-error', function (ev) {
      var d = JSON.parse(ev.data);
      toast('配置有问题：' + d.message);
    });
    es.onerror = function () { /* 浏览器会自动重连 */ };
  }

  function openEditor(item) {
    editing = item || null;
    var box = $('#mbox');
    box.textContent = '';
    box.appendChild(el('h3', '', item ? '编辑 ' + item.name : '添加一项'));

    function row(label, node) {
      var r = el('div', 'mrow');
      r.appendChild(el('label', '', label));
      r.appendChild(node);
      box.appendChild(r);
      return node;
    }

    var kindSel = el('select');
    [['service', '常驻服务'], ['script', '一次性脚本'], ['page', '静态页面']].forEach(function (k) {
      var o = el('option', '', k[1]);
      o.value = k[0];
      if (item && item.kind === k[0]) o.selected = true;
      kindSel.appendChild(o);
    });
    if (item) kindSel.disabled = true;
    row('类型', kindSel);

    var idInp = el('input');
    idInp.value = item ? item.id : '';
    idInp.placeholder = 'relay（字母数字下划线连字符）';
    if (item) idInp.disabled = true;
    row('ID', idInp);

    var nameInp = el('input');
    nameInp.value = item ? item.name : '';
    nameInp.placeholder = 'Provider Relay';
    row('名称', nameInp);

    var dyn = el('div');
    box.appendChild(dyn);

    function field(label, key, value, ph, hint) {
      var i = el('input');
      i.value = value != null ? value : '';
      i.placeholder = ph || '';
      i.dataset.key = key;
      row(label, i);
      if (hint) {
        var h = el('div', 'hint', hint);
        box.appendChild(h);
      }
      return i;
    }

    function rebuild() {
      dyn.textContent = '';
      var kind = kindSel.value;
      var saved = {};
      box.querySelectorAll('[data-key]').forEach(function (i) { saved[i.dataset.key] = i.value; });
      box.querySelectorAll('.mrow').forEach(function (r) {
        var lab = r.children[0].textContent;
        if (['命令', '参数', '工作目录', '端口', '面板地址', 'Shell', '脚本路径', '目录', '入口文件'].indexOf(lab) >= 0) r.remove();
      });
      box.querySelectorAll('.hint').forEach(function (h) { h.remove(); });

      if (kind === 'service') {
        field('命令', 'cmd', item && item.kind === 'service' ? item.cmd : saved.cmd, 'node', '可执行文件名或绝对路径，例如 node、python');
        field('参数', 'args', item && item.kind === 'service' ? (item.args || []).join(' ') : saved.args, 'index.mjs', '空格分隔，带空格的用引号包起来');
        field('工作目录', 'cwd', item && item.kind === 'service' ? item.cwd : saved.cwd, 'D:/work/xxx');
        field('端口', 'port', item && item.kind === 'service' ? item.port : saved.port, '8787', '用于 TCP 探活，留空则只检查进程存活');
        field('面板地址', 'url', item && item.kind === 'service' ? item.url : saved.url, 'http://127.0.0.1:8787/');
      } else if (kind === 'script') {
        var sel = el('select');
        ['powershell', 'python', 'bat'].forEach(function (s) {
          var o = el('option', '', s);
          o.value = s;
          if ((item && item.shell === s) || (!item && s === 'python')) o.selected = true;
          sel.appendChild(o);
        });
        sel.dataset.key = 'shell';
        row('Shell', sel);
        field('脚本路径', 'path', item && item.kind === 'script' ? item.path : saved.path, 'D:/work/xxx/run.ps1');
        field('参数', 'args', item && item.kind === 'script' ? (item.args || []).join(' ') : saved.args, '--verbose', '固定参数，空格分隔');
        field('工作目录', 'cwd', item && item.kind === 'script' ? item.cwd : saved.cwd, 'D:/work/xxx');
      } else {
        field('目录', 'dir', item && item.kind === 'page' ? item.dir : saved.dir, 'D:/work/notes');
        field('入口文件', 'entry', item && item.kind === 'page' ? item.entry : saved.entry, 'index.html');
      }
    }
    kindSel.addEventListener('change', rebuild);
    rebuild();

    var foot = el('div', 'mfoot');
    if (item) {
      var del = el('button', 'danger', '删除');
      del.onclick = async function () {
        if (!confirm('确定删除「' + item.name + '」？如果它正在运行会先停掉。')) return;
        try { await api('/api/items/' + item.id, { method: 'DELETE' }); closeEditor(); await loadState(); }
        catch (e) { toast(e.message); }
      };
      foot.appendChild(del);
    }
    foot.appendChild(el('div', 'spacer'));
    var cancel = el('button', '', '取消');
    cancel.onclick = closeEditor;
    foot.appendChild(cancel);
    var ok = el('button', 'primary', '保存');
    ok.onclick = saveEditor;
    foot.appendChild(ok);
    box.appendChild(foot);

    $('#modal').classList.add('on');

    async function saveEditor() {
      var body = { id: idInp.value.trim(), name: nameInp.value.trim(), kind: kindSel.value };
      box.querySelectorAll('[data-key]').forEach(function (i) {
        var k = i.dataset.key;
        var v = i.value;
        if (k === 'args') { body.args = v.trim() ? v.trim().match(/(?:[^\s"]+|"[^"]*")+/g).map(function (s) { return s.replace(/^"|"$/g, ''); }) : []; }
        else if (k === 'port') { body.port = v ? Number(v) : undefined; }
        else body[k] = v;
      });
      try {
        await api('/api/items', { method: 'POST', body: JSON.stringify(body) });
        closeEditor();
        await loadState();
      } catch (e) { toast(e.message); }
    }
  }

  function closeEditor() {
    editing = null;
    $('#modal').classList.remove('on');
  }

  function confirmDialog(opts) {
    var box = $('#mbox');
    box.textContent = '';
    box.appendChild(el('h3', '', opts.title));
    if (opts.text) box.appendChild(el('div', 'hint', opts.text));
    var foot = el('div', 'mfoot');
    var c = el('button', '', '取消');
    c.onclick = closeEditor;
    foot.appendChild(c);
    var ok = el('button', opts.danger ? 'danger' : 'primary', opts.okText || '确定');
    ok.onclick = async function () {
      ok.disabled = true;
      try {
        await opts.onOk();
        closeEditor();
      } catch (e) {
        toast(e.message);
        ok.disabled = false;
      }
    };
    foot.appendChild(ok);
    box.appendChild(foot);
    $('#modal').classList.add('on');
  }

  function confirmStopAll() {
    confirmDialog({
      title: '停止全部',
      text: '会 taskkill /T /F 掉所有正在运行的服务和脚本（含孙进程）。已经在运行的外部进程也会被杀掉。',
      okText: '全部停止',
      danger: true,
      onOk: async function () {
        await api('/api/stop-all', { method: 'POST' });
        await loadState();
      },
    });
  }

  // ---- 卡片右下角的三点菜单 ----
  var menuTarget = null;

  function openMenu(btn, id) {
    if (!findItem(id)) return;
    menuTarget = id;
    var menu = $('#menu');
    menu.textContent = '';

    function add(act, label, danger) {
      var b = el('button', danger ? 'danger' : '', label);
      b.dataset.menu = act;
      menu.appendChild(b);
    }
    add('logs', '日志');
    add('reveal', '打开所在文件夹');
    menu.appendChild(el('hr'));
    add('edit', '编辑');
    add('delete', '删除', true);

    // 先隐藏显示一次拿到真实尺寸，再定位，避免闪一下
    menu.style.visibility = 'hidden';
    menu.classList.add('on');
    var r = btn.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = Math.min(r.right - w, window.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.visibility = '';
  }

  function closeMenu() {
    $('#menu').classList.remove('on');
    menuTarget = null;
  }

  // ---- 设置 ----
  function fillSettings() {
    var s = state.settings || {};
    document.querySelectorAll('input[name="openMode"]').forEach(function (r) {
      r.checked = r.value === (s.openMode || 'window');
    });
    document.querySelectorAll('input[name="closeAction"]').forEach(function (r) {
      r.checked = r.value === (s.closeAction || 'quit');
    });
    document.querySelectorAll('input[name="dockMode"]').forEach(function (r) {
      r.checked = r.value === (s.dockMode || 'ring');
    });
    var box = $('#autoStartBox');
    if (box) box.checked = !!(state.autoStart && state.autoStart.enabled);
  }

  function renderAutoStart(st) {
    var badge = $('#autoStartBadge');
    var hint = $('#autoStartHint');
    if (!st) return;
    if (!st.supported) {
      badge.textContent = '不支持';
      badge.className = 'badge';
      hint.textContent = '只有 Windows 支持开机自启。';
      return;
    }
    badge.textContent = st.enabled ? '已注册' : '未注册';
    badge.className = 'badge' + (st.enabled ? ' on' : '');

    if (!st.ready) {
      hint.textContent = '还没建 .venv，先跑 shell/setup.bat。否则注册了也起不来。';
    } else if (st.enabled && st.stale) {
      hint.textContent = '注册的命令是旧版本（缺 --hidden 之类的参数），取消再勾一次即可更新。';
    } else if (st.enabled && st.method === 'startup') {
      hint.textContent = '注册表写不进去，已改用启动文件夹：' + (st.vbsPath || 'Startup\\Zen-Dock.vbs');
    } else if (st.enabled) {
      hint.textContent = '注册表里现在是：' + (st.command || 'Zen-Dock');
    } else if (st.regError) {
      hint.textContent =
        '读不到注册表（' + st.regError + '），可能被安全软件拦了。勾上会改用启动文件夹，那条路不需要调用外部程序。';
    } else {
      hint.textContent = '勾上会写入 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run，取消就删掉。';
    }
  }

  var currentPane = 'general';

  function switchPane(name) {
    currentPane = name;
    document.querySelectorAll('.snav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.pane === name);
    });
    document.querySelectorAll('.sbody .pane').forEach(function (pane) {
      var on = pane.dataset.pane === name;
      pane.classList.toggle('on', on);
      if (on) {
        // 摘掉再挂回去，切回来时动画重播一次
        pane.style.animation = 'none';
        void pane.offsetWidth;
        pane.style.animation = '';
      }
    });
  }

  function kvRow(k, v, cls) {
    var row = el('div', 'kv');
    row.appendChild(el('span', 'k', k));
    row.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v));
    return row;
  }

  async function loadAbout() {
    var box = $('#aboutKv');
    try {
      var d = await api('/api/about');
      box.textContent = '';
      [
        ['版本', 'v' + (d.version || '?')],
        ['Node', d.node],
        ['平台', d.platform + ' · ' + d.arch],
        ['WebView2', d.webview2 || '未检测到'],
        ['pywebview', d.pywebview || '未安装'],
        ['桌面外壳', d.shellReady ? '就绪' : '缺 .venv'],
        ['进程', 'pid ' + d.pid],
        ['已运行', fmtUptime(d.uptime * 1000)],
      ].forEach(function (r) { box.appendChild(kvRow(r[0], r[1])); });

      var paths = $('#aboutPaths');
      paths.textContent = '';
      [
        ['项目目录', d.rootPath, 'root'],
        ['配置文件', d.configPath, 'config'],
        ['日志目录', d.logDir, 'log'],
      ].forEach(function (r) {
        var row = kvRow(r[0], r[1], 'path');
        var v = row.children[1];
        v.title = '点击打开所在文件夹';
        v.onclick = function () {
          api('/api/reveal', { method: 'POST', body: JSON.stringify({ kind: r[2] }) }).catch(function (e) {
            toast(e.message);
          });
        };
        paths.appendChild(row);
      });

      var keys = $('#aboutKeys');
      keys.textContent = '';
      [
        ['唤出 / 收起快捷坞', 'Alt + X'],
        ['关闭抽屉、菜单或快捷坞', 'Esc'],
        ['启动服务 / 打开页面', '单击卡片'],
        ['日志 / 文件夹 / 编辑 / 删除', '卡片右下 ⋮'],
        ['启动服务 / 打开页面', '坞内单击扇形'],
        ['日志 / 文件夹 / 编辑 / 删除', '坞内右键扇形'],
      ].forEach(function (r) { keys.appendChild(kvRow(r[0], r[1])); });
    } catch (e) {
      box.textContent = '读取失败：' + e.message;
    }
  }

  var DOCK_MAX = 7;

  function dockPicked() {
    return ((state.settings && state.settings.dockItems) || []).slice();
  }

  function dockRow(item, index, total, on) {
    var row = el('div', 'ditem' + (on ? '' : ' off'));
    row.appendChild(el('span', 'idx', on ? String(index + 1) : '·'));
    row.appendChild(el('span', 'nm', item.name));

    if (on) {
      var up = el('button', 'mv', '\u2191');
      up.title = '上移';
      up.disabled = index === 0;
      up.onclick = function (ev) { ev.stopPropagation(); moveDock(index, -1); };
      var down = el('button', 'mv', '\u2193');
      down.title = '下移';
      down.disabled = index === total - 1;
      down.onclick = function (ev) { ev.stopPropagation(); moveDock(index, 1); };
      row.appendChild(up);
      row.appendChild(down);
    }

    var toggle = el('button', 'mv', on ? '移除' : '加入');
    toggle.disabled = !on && total >= DOCK_MAX;
    toggle.title = toggle.disabled ? '圆环最多 7 项' : '';
    toggle.onclick = function (ev) { ev.stopPropagation(); toggleDock(item.id, !on); };
    row.appendChild(toggle);
    return row;
  }

  function renderDockList() {
    var box = $('#dockList');
    if (!box) return;
    box.textContent = '';
    var picked = dockPicked();
    var badge = $('#dockCount');
    if (badge) {
      badge.textContent = picked.length + ' / ' + DOCK_MAX;
      badge.classList.toggle('on', picked.length === DOCK_MAX);
    }

    picked.forEach(function (id, i) {
      var it = findItem(id);
      if (it) box.appendChild(dockRow(it, i, picked.length, true));
    });
    state.items.forEach(function (it) {
      if (picked.indexOf(it.id) < 0) box.appendChild(dockRow(it, -1, picked.length, false));
    });
    if (!state.items.length) box.appendChild(el('p', 'hint', '还没有任何项'));
  }

  async function toggleDock(id, add) {
    var picked = dockPicked();
    if (add) {
      if (picked.length >= DOCK_MAX) return toast('最多 ' + DOCK_MAX + ' 项');
      if (picked.indexOf(id) >= 0) return;
      picked.push(id);
    } else {
      picked = picked.filter(function (x) { return x !== id; });
    }
    await saveSetting({ dockItems: picked });
    renderDockList();
  }

  async function moveDock(index, delta) {
    var picked = dockPicked();
    var j = index + delta;
    if (j < 0 || j >= picked.length) return;
    var t = picked[index];
    picked[index] = picked[j];
    picked[j] = t;
    await saveSetting({ dockItems: picked });
    renderDockList();
  }

  async function openSettings() {
    closeMenu();
    closeDrawer();
    $('#settings').classList.add('on');
    $('#overlay').classList.add('on');
    switchPane(currentPane);
    fillSettings();
    loadAbout();
    try {
      var d = await api('/api/settings');
      state.settings = d.settings;
      state.autoStart = d.autoStart;
      fillSettings();
      renderAutoStart(d.autoStart);
      loadBrowsers();
      renderDockList();
      $('#hotkeyInput').value = (d.settings && d.settings.hotkey) || 'alt+x';
    } catch (e) {
      toast(e.message);
    }
  }

  function closeSettings() {
    $('#settings').classList.remove('on');
    $('#overlay').classList.remove('on');
  }

  async function saveSetting(patch) {
    try {
      var d = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
      state.settings = d.settings;
      toast('已保存');
    } catch (e) {
      toast(e.message);
    }
  }

  async function toggleAutoStart(enabled) {
    try {
      var st = await api('/api/autostart', { method: 'POST', body: JSON.stringify({ enabled: enabled }) });
      state.autoStart = st;
      renderAutoStart(st);
      fillSettings();
      if (st && st.note) toast(st.note);
      else toast(enabled ? '已注册开机自启' : '已取消开机自启');
    } catch (e) {
      toast(e.message);
      $('#autoStartBox').checked = !enabled;
    }
  }

  async function loadBrowsers() {
    var sel = $('#browserSel');
    try {
      var d = await api('/api/browsers');
      sel.textContent = '';
      var auto = el('option', '', '自动（优先 Chrome）');
      auto.value = '';
      sel.appendChild(auto);
      (d.browsers || []).forEach(function (b) {
        var o = el('option', '', b.name + ' — ' + b.path);
        o.value = b.path;
        sel.appendChild(o);
      });
      sel.value = d.current || '';
      $('#browserHint').textContent = (d.browsers || []).length
        ? '检测到 ' + d.browsers.length + ' 个 Chromium 系浏览器。'
        : '没检测到 Chromium 系浏览器，会退回系统默认（只能开成标签页）。';
    } catch (e) {
      $('#browserHint').textContent = '读取失败：' + e.message;
    }
  }

  async function applyHotkey() {
    var spec = $('#hotkeyInput').value.trim().toLowerCase();
    if (!spec) {
      toast('先填一个组合键');
      return;
    }
    var badge = $('#hotkeyBadge');
    badge.textContent = '注册中';
    badge.className = 'badge';

    if (window.pywebview && window.pywebview.api && window.pywebview.api.set_hotkey) {
      try {
        var r = await window.pywebview.api.set_hotkey(spec);
        if (r && r.ok) {
          badge.textContent = '已生效';
          badge.className = 'badge on';
          $('#hotkeyHint').textContent = '当前：' + (r.spec || spec);
          toast('快捷键已生效');
        } else {
          badge.textContent = '冲突';
          badge.className = 'badge';
          $('#hotkeyHint').textContent = '注册失败：' + ((r && r.error) || '这个组合可能被别的程序占了');
          toast('注册失败，换一个组合');
        }
      } catch (e) {
        toast(e.message);
      }
      return;
    }

    // 浏览器里没有 pywebview，只能先存配置
    await saveSetting({ hotkey: spec });
    badge.textContent = '待重启';
    badge.className = 'badge';
    $('#hotkeyHint').textContent = '已保存。热键由桌面窗口注册，重启后生效。';
  }

  document.addEventListener('click', function (ev) {
    var mbtn = ev.target.closest('button[data-menu]');
    if (mbtn) {
      ev.stopPropagation();
      var targetId = menuTarget;
      closeMenu();
      doAction(targetId, mbtn.dataset.menu);
      return;
    }

    var btn = ev.target.closest('button[data-act]');
    if (btn) {
      ev.stopPropagation();
      var card = btn.closest('.card');
      var id = btn.dataset.id || (card && card.dataset.id) || drawer.id;
      if (btn.dataset.act === 'menu') {
        openMenu(btn, id);
      } else {
        closeMenu();
        doAction(id, btn.dataset.act);
      }
      return;
    }

    closeMenu();

    var c = ev.target.closest('.card');
    if (c && c.dataset.id) {
      openDrawer(c.dataset.id);
      return;
    }
  });

  $('#grid').addEventListener('click', function (ev) {
    if (ev.target.id === 'addCard') openEditor(null);
  });
  $('#addBtn').onclick = function () { openEditor(null); };
  $('#settingsBtn').onclick = openSettings;
  $('#closeSettingsBtn').onclick = closeSettings;
  $('#stopAll').onclick = confirmStopAll;
  $('#overlay').onclick = function () { closeDrawer(); closeSettings(); };

  document.querySelectorAll('input[name="openMode"]').forEach(function (r) {
    r.onchange = function () { saveSetting({ openMode: r.value }); };
  });
  document.querySelectorAll('input[name="closeAction"]').forEach(function (r) {
    r.onchange = function () { saveSetting({ closeAction: r.value }); };
  });
  $('#autoStartBox').onchange = function () { toggleAutoStart(this.checked); };
  $('#browserSel').onchange = function () { saveSetting({ browser: this.value }); };
  $('#hotkeyApply').onclick = applyHotkey;
  document.querySelectorAll('.snav button').forEach(function (b) {
    b.onclick = function () { switchPane(b.dataset.pane); };
  });
  document.querySelectorAll('input[name="dockMode"]').forEach(function (r) {
    r.onchange = function () { saveSetting({ dockMode: this.value }); };
  });

  $('#log').addEventListener('scroll', function () {
    var log = $('#log');
    drawer.follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });
  $('#modal').addEventListener('click', function (ev) { if (ev.target.id === 'modal') closeEditor(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      closeEditor();
      closeDrawer();
      closeSettings();
      closeMenu();
    }
  });

  var addCard = el('div', 'card add', '+ 添加');
  addCard.id = 'addCard';
  $('#grid').appendChild(addCard);
  setCols(targetCols());

  // 给桌面外壳留的钩子：拓展坞里点「日志」/「编辑」时，
  // Python 侧会 evaluate_js 调这里，把主窗口切到对应视图。
  window.__zenDock = {
    openDrawer: function (id) { openDrawer(id); },
    openEditor: function (id) {
      var it = findItem(id);
      if (it) openEditor(it);
    },
    reload: function () { loadState(); },
  };

  // ---- 桌面外壳（pywebview）集成 ----
  // 主窗口是无边框的，标题栏、窗口按钮、边缘缩放都得页面自己接。
  // 浏览器里打开时 shell.on 一直是 false，这些全部不生效。
  var shell = { on: false };

  function shellApi(name) {
    var a = window.pywebview && window.pywebview.api;
    if (!a || typeof a[name] !== 'function') return null;
    try { return a[name].apply(a, Array.prototype.slice.call(arguments, 1)); } catch (e) { return null; }
  }

  function syncMax(on) {
    var b = document.querySelector('#wctl button[data-w="max"]');
    if (!b) return;
    b.innerHTML = on
      ? '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="3.4" width="4.6" height="4.6" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M3.7 3.4V2.2h4.1v4.1H6.6" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.2" y="2.2" width="5.6" height="5.6" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    b.title = on ? '还原' : '最大化';
  }

  // 认外壳：旧版外壳没有 win_drag_begin，就当作普通网页处理，别把标题栏弄坏
  function markShell() {
    if (shell.on) return true;
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.win_drag_begin)) return false;
    shell.on = true;
    document.body.classList.add('shell');
    var st = shellApi('win_state');
    if (st && st.then) st.then(function (s) { if (s) syncMax(!!s.maximized); });
    return true;
  }

  // 拖动和缩放都在 JS 侧算位移，Python 侧只负责 SetWindowPos。
  // 用 screenX/screenY 而不是 clientX：窗口跟着鼠标动，client 坐标会互相抵消。
  var drag = null;
  var dragRaf = 0;

  // 边缘缩放。**不依赖热区元素命中**：直接按视口坐标算。
  // 之前用 8 个绝对定位的 i 元素做热区，实测点右下角没反应（事件落到了
  // 别的地方，日志里记的是"拖动开始"），改成算坐标就不会被任何层盖住。
  // CSS 里那 8 个 i 还留着，只负责给鼠标换 cursor。
  var EDGE = 5;

  function edgeDir(x, y) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var d = '';
    if (y <= EDGE) d += 'n';
    else if (y >= h - EDGE) d += 's';
    if (x <= EDGE) d += 'w';
    else if (x >= w - EDGE) d += 'e';
    return d;
  }

  function onDragMove(ev) {
    if (!drag) return;
    drag.dx = ev.screenX - drag.x0;
    drag.dy = ev.screenY - drag.y0;
    if (dragRaf) return;  // 一帧只发一次，别让 js_api 调用堆积
    dragRaf = requestAnimationFrame(function () {
      dragRaf = 0;
      if (drag) shellApi('win_drag_to', drag.dx, drag.dy);
    });
  }

  function onDragEnd() {
    drag = null;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    shellApi('win_drag_end');
  }

  document.getElementById('titlebar').addEventListener('mousedown', function (ev) {
    if (!shell.on || ev.button !== 0) return;
    if (ev.target.closest('button')) return;  // 按钮区不拖动
    if (edgeDir(ev.clientX, ev.clientY)) return;  // 落在边缘上，让给缩放
    ev.preventDefault();
    shellApi('win_drag_begin');
    drag = { x0: ev.screenX, y0: ev.screenY, dx: 0, dy: 0 };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  document.getElementById('titlebar').addEventListener('dblclick', function (ev) {
    if (!shell.on || ev.target.closest('button')) return;
    var r = shellApi('win_maximize');
    if (r && r.then) r.then(function (s) { if (s) syncMax(!!s.maximized); });
  });

  document.getElementById('wctl').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || !shell.on) return;
    var w = b.getAttribute('data-w');
    if (w === 'min') shellApi('win_minimize');
    else if (w === 'close') shellApi('win_close');
    else if (w === 'max') {
      var r = shellApi('win_maximize');
      if (r && r.then) r.then(function (s) { if (s) syncMax(!!s.maximized); });
    }
  });

  var rz = null;
  var rzRaf = 0;

  function onRzMove(ev) {
    if (!rz) return;
    rz.dx = ev.screenX - rz.x0;
    rz.dy = ev.screenY - rz.y0;
    if (rzRaf) return;
    rzRaf = requestAnimationFrame(function () {
      rzRaf = 0;
      if (rz) shellApi('win_resize_to', rz.dx, rz.dy);
    });
  }

  function onRzEnd() {
    rz = null;
    if (rzRaf) { cancelAnimationFrame(rzRaf); rzRaf = 0; }
    document.removeEventListener('mousemove', onRzMove);
    document.removeEventListener('mouseup', onRzEnd);
    shellApi('win_resize_end');
  }

  document.getElementById('rz').addEventListener('mousedown', function (ev) {
    var d = ev.target.getAttribute('data-d');
    if (!d || !shell.on || ev.button !== 0) return;
    ev.preventDefault();
    startResize(d, ev);
  });

  // 兜底：热区元素没命中时也认边缘。document 级监听在 titlebar 之后跑，
  // 所以标题栏里靠边的那几像素已经被上面那个 handler 让出来了。
  document.addEventListener('mousedown', function (ev) {
    if (!shell.on || ev.button !== 0 || drag || rz) return;
    if (ev.target.closest && ev.target.closest('#rz')) return;  // 上面已经处理
    var d = edgeDir(ev.clientX, ev.clientY);
    if (!d) return;
    ev.preventDefault();
    startResize(d, ev);
  });

  function startResize(dir, ev) {
    shellApi('win_resize_begin', dir);
    rz = { x0: ev.screenX, y0: ev.screenY, dx: 0, dy: 0 };
    document.addEventListener('mousemove', onRzMove);
    document.addEventListener('mouseup', onRzEnd);
  }

  if (!markShell()) {
    window.addEventListener('pywebviewready', markShell);
    var shellTries = 0;
    var shellTimer = setInterval(function () {
      if (markShell() || ++shellTries > 40) clearInterval(shellTimer);
    }, 150);
  }

  loadState().then(connect).catch(function (e) { toast('加载失败：' + e.message); });
})();
`;

export function renderPanel() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zen-Dock</title>
<style>${CSS}</style>
</head>
<body>
<header id="titlebar">
  <div class="brand">Zen-Dock<small>本地服务面板</small></div>
  <div class="spacer"></div>
  <button id="addBtn">+ 添加</button>
  <button id="settingsBtn">设置</button>
  <button id="stopAll" class="danger">全停</button>
  <div class="wctl" id="wctl">
    <button data-w="min" title="最小化"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
    <button data-w="max" title="最大化"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.2" y="2.2" width="5.6" height="5.6" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
    <button data-w="close" title="关闭"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.6 2.6l4.8 4.8M7.4 2.6l-4.8 4.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
  </div>
</header>
<main id="grid"></main>

<div id="rz"><i data-d="n"></i><i data-d="s"></i><i data-d="w"></i><i data-d="e"></i><i data-d="nw"></i><i data-d="ne"></i><i data-d="sw"></i><i data-d="se"></i></div>

<div id="overlay"></div>
<aside id="drawer">
  <div class="dhead" id="dhead"></div>
  <div class="dbody">
    <div id="log"></div>
    <div class="side" id="dside"></div>
  </div>
</aside>

<div id="menu"></div>

<aside id="settings">
  <div class="dhead">
    <span class="name">设置</span>
    <div class="spacer"></div>
    <button id="closeSettingsBtn">✕</button>
  </div>
  <div class="swrap">
    <nav class="snav">
      <button data-pane="general" class="on">通用</button>
      <button data-pane="window">窗口</button>
      <button data-pane="dock">快捷坞</button>
      <button data-pane="system">系统</button>
      <button data-pane="about">关于</button>
    </nav>
    <div class="sbody">
      <div class="pane on" data-pane="general">
        <section>
          <h4>打开页面</h4>
          <label class="opt">
            <input type="radio" name="openMode" value="window">
            <span class="txt"><b>新浏览器窗口</b><span>带地址栏，能复制 URL、前进后退</span></span>
          </label>
          <label class="opt">
            <input type="radio" name="openMode" value="app">
            <span class="txt"><b>无地址栏独立窗口</b><span>像独立应用，但没有地址栏和标签栏</span></span>
          </label>
        </section>
        <section>
          <h4>打开页面用的浏览器</h4>
          <select id="browserSel" style="width:100%"></select>
          <p class="hint" id="browserHint"></p>
        </section>
      </div>
      <div class="pane" data-pane="window">
        <section>
          <h4>关闭窗口时</h4>
          <label class="opt">
            <input type="radio" name="closeAction" value="quit">
            <span class="txt"><b>退出程序</b><span>连自己启动的服务一起停掉</span></span>
          </label>
          <label class="opt">
            <input type="radio" name="closeAction" value="tray">
            <span class="txt"><b>最小化到托盘</b><span>服务继续跑，从托盘图标恢复窗口</span></span>
          </label>
          <p class="hint">只在桌面窗口里有效；用浏览器访问时这条不起作用</p>
        </section>
      </div>
      <div class="pane" data-pane="dock">
        <section>
          <h4>坞形态</h4>
          <label class="opt">
            <input type="radio" name="dockMode" value="ring">
            <span class="txt"><b>圆环</b><span>围绕鼠标弹出八块扇形，12 点固定是主页</span></span>
          </label>
          <label class="opt">
            <input type="radio" name="dockMode" value="panel">
            <span class="txt"><b>面板</b><span>原来的矩形卡片列表，信息更密</span></span>
          </label>
        </section>
        <section>
          <h4>唤出快捷键 <span class="badge" id="hotkeyBadge">未检测</span></h4>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="hotkeyInput" placeholder="alt+x" style="flex:1;font-family:var(--mono)">
            <button id="hotkeyApply">应用</button>
          </div>
          <p class="hint" id="hotkeyHint">形如 alt+x、ctrl+alt+space。注册失败说明这个组合已被别的程序占用。</p>
        </section>
        <section>
          <h4>坞内快捷项 <span class="badge" id="dockCount">0 / 7</span></h4>
          <p class="hint">圆环只有 8 个方位，12 点留给「主页」，所以最多 7 项。列表顺序就是方位顺序。</p>
          <div class="docklist" id="dockList"></div>
        </section>
      </div>
      <div class="pane" data-pane="system">
        <section>
          <h4>开机自启 <span class="badge" id="autoStartBadge">检查中</span></h4>
          <label class="opt">
            <input type="checkbox" id="autoStartBox">
            <span class="txt"><b>开机时自动启动 Zen-Dock</b><span>写进 HKCU 的 Run 键，不需要管理员权限</span></span>
          </label>
          <p class="hint" id="autoStartHint"></p>
        </section>
      </div>
      <div class="pane" data-pane="about">
        <section>
          <h4>版本与环境</h4>
          <div id="aboutKv"></div>
        </section>
        <section>
          <h4>路径</h4>
          <div id="aboutPaths"></div>
        </section>
        <section>
          <h4>快捷键</h4>
          <div id="aboutKeys"></div>
        </section>
      </div>
    </div>
  </div>
</aside>

<div id="modal"><div class="mbox" id="mbox"></div></div>
<div id="toast" style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1d2534;border:1px solid #3a4557;color:#dfe6f0;padding:9px 16px;border-radius:8px;font-size:12px;opacity:0;transition:.2s;pointer-events:none;z-index:80"></div>

<script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ============================================================
// 拓展坞页面（/dock）
// 无标题栏、置顶、鼠标附近弹出、真失焦自动关闭。
// 卡片整块可点即启动，其余操作收进右下角三点菜单。
// ============================================================

const DOCK_CSS = `
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden}
body{background:#0b0e14;color:#dfe6f0;font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;user-select:none}
#wrap{height:100%;display:flex;flex-direction:column;padding:10px}
#head{display:flex;align-items:center;gap:8px;padding:0 2px 8px;flex:none}
#head .t{font-size:12px;color:#7d8799}
#head .k{margin-left:auto;font-size:10px;color:#48515f;font-family:ui-monospace,Consolas,monospace}
#dgrid{flex:1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start;overflow-y:auto;padding-right:2px}
#dgrid::-webkit-scrollbar{width:0}
.dcard{position:relative;background:#161b26;border:1px solid #232a38;border-radius:8px;padding:9px 11px 11px;display:flex;flex-direction:column;gap:4px;cursor:pointer;transition:border-color .12s,background .12s}
.dcard:hover{border-color:#3a4557;background:#1a2230}
.dcard.busy{opacity:.55;pointer-events:none}
.dcard.err{border-color:#5c2b28}
.row{display:flex;align-items:center;gap:7px;min-width:0}
.dot{width:7px;height:7px;border-radius:50%;background:#5a6474;flex:none}
.dot.running{background:#3fb950}
.dot.starting,.dot.stopping{background:#d29922;animation:pulse 1.1s infinite}
.dot.crashed,.dot.failed{background:#f85149}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.name{font-size:12px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#5a6474;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.errmsg{font-size:10px;color:#ff7b72;line-height:1.4}
.more{position:absolute;right:2px;bottom:0;border:none;background:transparent;color:#3f4856;font-size:13px;line-height:1;padding:3px 6px;cursor:pointer;border-radius:4px}
.more:hover{color:#dfe6f0;background:#232a38}
#dmenu{position:fixed;z-index:99;min-width:152px;padding:4px;background:#161b26;border:1px solid #2f3949;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.5);display:none}
#dmenu.on{display:block}
#dmenu button{display:block;width:100%;text-align:left;border:none;background:transparent;color:#dfe6f0;padding:7px 10px;border-radius:5px;font-size:12px;cursor:pointer}
#dmenu button:hover{background:#212a39}
#dmenu button.danger{color:#ff7b72}
#dmenu hr{border:none;border-top:1px solid #232a38;margin:4px 2px}
#empty{grid-column:1/-1;text-align:center;color:#5a6474;font-size:12px;padding:44px 0}
`;

const DOCK_JS = String.raw`
(function () {
  var items = [];
  var menuId = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function $(s) { return document.querySelector(s); }
  function findItem(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }
  function baseName(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }
  function statusCls(item) {
    var rt = item.runtime || {};
    if (!rt.status) return '';
    if (rt.status === 'running') return 'running';
    if (rt.status === 'starting' || rt.status === 'stopping') return 'starting';
    if (rt.status === 'crashed' || rt.status === 'failed') return 'crashed';
    return '';
  }
  function metaOf(item) {
    var rt = item.runtime || {};
    if (item.kind === 'service') {
      var head = item.port ? ':' + item.port : (item.cmd || '');
      if (rt.status === 'running') return head + ' · 运行中';
      if (rt.exitCode != null) return head + ' · exit ' + rt.exitCode;
      return head;
    }
    if (item.kind === 'script') {
      var s = baseName(item.path);
      if (rt.status === 'running') return s + ' · 运行中';
      if (rt.exitCode != null) return s + ' · exit ' + rt.exitCode;
      return s;
    }
    return '/s/' + item.id + '/';
  }

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  function callPy(method, arg) {
    if (window.pywebview && window.pywebview.api && typeof window.pywebview.api[method] === 'function') {
      try {
        var r = window.pywebview.api[method](arg);
        if (r && typeof r.catch === 'function') r.catch(function () {});
        return r;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function closeDock() {
    if (callPy('close') === null) window.close();
  }
  function showLogs(id) {
    if (callPy('show_logs', id) === null) window.close();
  }
  function showEdit(id) {
    if (callPy('show_edit', id) === null) window.close();
  }

  function buildCard(item) {
    var c = el('div', 'dcard');
    c.dataset.id = item.id;
    var row = el('div', 'row');
    row.appendChild(el('span', 'dot'));
    row.appendChild(el('span', 'name'));
    c.appendChild(row);
    c.appendChild(el('div', 'meta'));
    var more = el('button', 'more', '\u22EE');
    more.title = '更多';
    c.appendChild(more);
    updateCard(c, item);
    return c;
  }

  function updateCard(c, item) {
    c.children[0].children[0].className = 'dot ' + statusCls(item);
    c.children[0].children[1].textContent = item.name;
    c.children[1].textContent = metaOf(item);
  }

  function render() {
    var grid = $('#dgrid');
    grid.textContent = '';
    if (!items.length) {
      var e = el('div', '', '没有可用的项');
      e.id = 'empty';
      grid.appendChild(e);
      return;
    }
    items.forEach(function (it) { grid.appendChild(buildCard(it)); });
  }

  async function load() {
    try {
      var d = await api('/api/state');
      items = d.items || [];
      render();
    } catch (e) {
      var grid = $('#dgrid');
      grid.textContent = '';
      var m = el('div', '', '连不上服务：' + e.message);
      m.id = 'empty';
      grid.appendChild(m);
    }
  }

  function showError(id, msg) {
    var card = document.querySelector('.dcard[data-id="' + id + '"]');
    if (!card) return;
    card.classList.add('err');
    var old = card.querySelector('.errmsg');
    if (old) old.remove();
    card.appendChild(el('div', 'errmsg', msg));
  }

  async function openPage(item) {
    var url = (item.runtime && item.runtime.url) || item.url || ('/s/' + item.id + '/');
    if (url.charAt(0) === '/') url = location.origin + url;
    await api('/api/open-window', { method: 'POST', body: JSON.stringify({ url: url }) });
  }

  async function activate(item) {
    var rt = item.runtime || {};

    if (item.kind === 'page') {
      try {
        await openPage(item);
        closeDock();
      } catch (e) { showError(item.id, e.message); }
      return;
    }

    if (rt.status === 'running') {
      if (item.kind === 'service' && (item.url || rt.url)) {
        try { await openPage(item); closeDock(); } catch (e) { showError(item.id, e.message); }
      } else {
        closeDock();
      }
      return;
    }
    if (rt.status === 'starting') return;

    var card = document.querySelector('.dcard[data-id="' + item.id + '"]');
    if (card) {
      card.classList.add('busy');
      card.classList.remove('err');
      var old = card.querySelector('.errmsg');
      if (old) old.remove();
    }

    try {
      if (item.kind === 'service') {
        var r = await api('/api/items/' + item.id + '/start', { method: 'POST' });
        if (r.runtime && r.runtime.status === 'running') {
          closeDock();
        } else {
          showError(item.id, '启动失败：' + ((r.runtime && r.runtime.status) || '未知'));
        }
      } else {
        await api('/api/items/' + item.id + '/run', { method: 'POST', body: '{}' });
        closeDock();
      }
    } catch (e) {
      showError(item.id, e.message);
    } finally {
      if (card) card.classList.remove('busy');
    }
  }

  function openMenu(btn, id) {
    if (!findItem(id)) return;
    menuId = id;
    var menu = $('#dmenu');
    menu.textContent = '';
    function add(act, label, danger) {
      var b = el('button', danger ? 'danger' : '', label);
      b.dataset.menu = act;
      menu.appendChild(b);
    }
    add('logs', '日志');
    add('reveal', '打开所在文件夹');
    menu.appendChild(el('hr'));
    add('edit', '编辑');
    add('delete', '删除', true);

    menu.style.visibility = 'hidden';
    menu.classList.add('on');
    var r = btn.getBoundingClientRect();
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var left = Math.min(r.right - w, window.innerWidth - w - 6);
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 6) top = r.top - h - 4;
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';
    menu.style.visibility = '';
  }

  function closeMenu() {
    $('#dmenu').classList.remove('on');
    menuId = null;
  }

  async function handleMenu(id, act) {
    var item = findItem(id);
    if (!item) return;
    if (act === 'logs') { showLogs(id); return; }
    if (act === 'edit') { showEdit(id); return; }
    try {
      if (act === 'reveal') {
        await api('/api/items/' + id + '/reveal', { method: 'POST' });
      } else if (act === 'delete') {
        if (!confirm('删除「' + item.name + '」？')) return;
        await api('/api/items/' + id, { method: 'DELETE' });
        await load();
      }
    } catch (e) {
      showError(id, e.message);
    }
  }

  document.addEventListener('click', function (ev) {
    var mb = ev.target.closest('button[data-menu]');
    if (mb) {
      ev.stopPropagation();
      var act = mb.dataset.menu;
      var id = menuId;
      closeMenu();
      handleMenu(id, act);
      return;
    }
    var more = ev.target.closest('.more');
    if (more) {
      ev.stopPropagation();
      var card = more.closest('.dcard');
      openMenu(more, card.dataset.id);
      return;
    }
    closeMenu();
    var c = ev.target.closest('.dcard');
    if (c && c.dataset.id) {
      var item = findItem(c.dataset.id);
      if (item) activate(item);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      closeMenu();
      closeDock();
    }
  });

  load();
})();
`;

function renderPanelDock() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zen-Dock</title>
<style>${DOCK_CSS}</style>
</head>
<body>
<div id="wrap">
  <div id="head">
    <span class="t">快速启动</span>
    <span class="k">Esc 关闭</span>
  </div>
  <div id="dgrid"></div>
</div>
<div id="dmenu"></div>
<script>${DOCK_JS}</script>
</body>
</html>`;
}

// ============================================================
// 圆环坞（/dock 的默认形态）
//
// 八块独立的圆角扇形围绕鼠标等角分布，12 点固定是「主页」。
// 窗口是透明的，Python 侧用 SetWindowRgn 把命中区域裁成环形，
// 所以环外点击直接穿透到桌面，不会有个看不见的矩形挡着。
//
// 圆心固定在窗口中心（200,200）——窗口位置由 Python 按鼠标居中摆放，
// 贴边时窗口允许超出屏幕，不 clamp，否则圆心就跟鼠标对不上了。
// ============================================================

const RING_CSS = `
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden;background:transparent}
body{font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;user-select:none}
#ring{display:block;width:100%;height:100%;overflow:visible}
.slot{cursor:pointer;transform-box:view-box;transform-origin:200px 200px;animation:bloom .34s cubic-bezier(.34,1.56,.64,1) backwards}
@keyframes bloom{from{opacity:0;transform:scale(.25)}60%{opacity:1}to{opacity:1;transform:scale(1)}}
#ring.closing .slot{animation:collapse .19s cubic-bezier(.4,0,.9,.4) forwards;animation-delay:0ms!important}
@keyframes collapse{to{opacity:0;transform:scale(.3)}}
/* 扇形不要描边。窗口是透明窗口 + 硬区域裁剪，边缘只有一层抗锯齿；
   再加一圈 stroke 就等于在抗锯齿外面又叠一条实线，浅色背景上会显成
   "每个扇形外面有一层边"。状态靠填充色和图标/文字颜色区分就够了。 */
.sector{fill:#161b26;transition:fill .14s}
.slot:hover .sector{fill:#1f2a3a}
.slot.running .sector{fill:#1a2431}
.slot.running:hover .sector{fill:#22303f}
.slot.busy .sector{fill:#1a212e}
.slot.err .sector{fill:#1e1a1c}
.slot.home .sector{fill:#141c28}
.slot.home:hover .sector{fill:#1a2433}
.slot text{font-size:11px;fill:#9aa6b8;text-anchor:middle;dominant-baseline:central;transition:fill .14s;pointer-events:none}
.slot:hover text{fill:#dfe6f0}
.slot.running text{fill:#7ee787}
.slot.home text{fill:#7fb0e8}
.ico{fill:none;stroke:#7d8799;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;transition:stroke .14s;pointer-events:none}
.slot:hover .ico{stroke:#c9d4e3}
.slot.running .ico{stroke:#c9d4e3}
.slot.home .ico{stroke:#7fb0e8}
.errmsg{font-size:10px;fill:#ff7b72;text-anchor:middle;pointer-events:none}
`;

const RING_JS = String.raw`
(function () {
  var CX = 200, CY = 200;
  // 径向厚度要明显大于弧长才像扇形：厚 118、弧长约 87，比例 1.35:1。
  // 之前是 92 对 91，接近正方形，看起来像圆角方块。
  var R_OUT = 184, R_IN = 66, RC = 10;
  var CONTENT_R = (R_OUT + R_IN) / 2;
  var MAX_HALF = 34;
  var HOME = '__home';

  var items = [];
  var slots = [];
  var busy = {};

  function el(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function findItem(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }
  function polar(r, deg) {
    var a = (deg * Math.PI) / 180;
    return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
  }
  function p2s(p) {
    return p[0].toFixed(2) + ' ' + p[1].toFixed(2);
  }

  function sectorPath(a1, a2) {
    var dout = (RC / R_OUT) * (180 / Math.PI);
    var din = (RC / R_IN) * (180 / Math.PI);
    var d = 'M' + p2s(polar(R_OUT, a1 + dout));
    d += ' A' + R_OUT + ' ' + R_OUT + ' 0 0 1 ' + p2s(polar(R_OUT, a2 - dout));
    d += ' Q' + p2s(polar(R_OUT, a2)) + ' ' + p2s(polar(R_OUT - RC, a2));
    d += ' L' + p2s(polar(R_IN + RC, a2));
    d += ' Q' + p2s(polar(R_IN, a2)) + ' ' + p2s(polar(R_IN, a2 - din));
    d += ' A' + R_IN + ' ' + R_IN + ' 0 0 0 ' + p2s(polar(R_IN, a1 + din));
    d += ' Q' + p2s(polar(R_IN, a1)) + ' ' + p2s(polar(R_IN + RC, a1));
    d += ' L' + p2s(polar(R_OUT - RC, a1));
    d += ' Q' + p2s(polar(R_OUT, a1)) + ' ' + p2s(polar(R_OUT, a1 + dout));
    return d + ' Z';
  }

  function iconMarkup(kind) {
    if (kind === 'home') {
      return '<rect x="-6" y="-6" width="5" height="5" rx="1"/><rect x="1" y="-6" width="5" height="5" rx="1"/>' +
             '<rect x="-6" y="1" width="5" height="5" rx="1"/><rect x="1" y="1" width="5" height="5" rx="1"/>';
    }
    if (kind === 'service') {
      return '<rect x="-7" y="-6" width="14" height="12" rx="2"/><line x1="-7" y1="-2" x2="7" y2="-2"/>';
    }
    if (kind === 'script') {
      return '<path d="M-5 -6 L5 0 L-5 6 Z"/>';
    }
    return '<rect x="-5" y="-7" width="10" height="14" rx="1.5"/>' +
           '<line x1="-2.5" y1="-3" x2="2.5" y2="-3"/><line x1="-2.5" y1="0.5" x2="2.5" y2="0.5"/>';
  }

  function statusClass(item) {
    if (!item) return '';
    var st = (item.runtime || {}).status;
    if (st === 'running') return 'running';
    if (st === 'starting' || st === 'stopping') return 'busy';
    if (st === 'crashed' || st === 'failed') return 'err';
    return '';
  }

  // 用 canvas 实测文字宽度再截断。按字符数估算（汉字算 2、英文算 1）在
  // 中英混排时误差很大，"Provider Relay" 会溢出扇区跑到窗口外面被裁掉。
  var _mctx = null;
  function measureWidth(text) {
    if (!_mctx) {
      _mctx = document.createElement('canvas').getContext('2d');
      _mctx.font = '11px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
    }
    return _mctx.measureText(text).width;
  }

  function labelOf(item, step) {
    if (!item) return '主页';
    var raw = (item.shortName || item.name || item.id || '').trim();
    var half = Math.min(step / 2 - 2.5, MAX_HALF);
    // 弧长就是文字可用的横向空间，两侧各留 5px 给扇区边缘
    var maxPx = Math.max(28, ((half * 2) * Math.PI / 180) * CONTENT_R - 10);
    if (measureWidth(raw) <= maxPx) return raw;
    var out = '';
    for (var i = 0; i < raw.length; i++) {
      if (measureWidth(out + raw[i] + '\u2026') > maxPx) break;
      out += raw[i];
    }
    return out + '\u2026';
  }

  function buildSlot(entry, index, total) {
    var step = 360 / total;
    var half = Math.min(step / 2 - 2.5, MAX_HALF);
    var mid = index * step;

    var g = el('g', { class: 'slot' });
    g.dataset.id = entry.id;
    g.style.animationDelay = index * 25 + 'ms';
    if (entry.id === HOME) g.classList.add('home');
    var cls = statusClass(entry.item);
    if (cls) g.classList.add(cls);

    g.appendChild(el('path', { class: 'sector', d: sectorPath(mid - half, mid + half) }));

    var pos = polar(CONTENT_R, mid);
    var content = el('g', { transform: 'translate(' + pos[0].toFixed(1) + ',' + pos[1].toFixed(1) + ')' });
    var ico = el('g', { class: 'ico', transform: 'translate(0,-9)' });
    ico.innerHTML = iconMarkup(entry.id === HOME ? 'home' : entry.item.kind);
    content.appendChild(ico);

    var t = el('text', { y: '13' });
    t.textContent = entry.id === HOME ? '主页' : labelOf(entry.item, step);
    content.appendChild(t);

    g.appendChild(content);
    return g;
  }

  function render() {
    var svg = document.getElementById('ring');
    svg.textContent = '';
    slots.forEach(function (entry, i) {
      svg.appendChild(buildSlot(entry, i, slots.length));
    });
  }

  function computeSlots() {
    var picked = (state.settings && state.settings.dockItems) || [];
    slots = [{ id: HOME, item: null }];
    picked.forEach(function (id) {
      var it = findItem(id);
      if (it) slots.push({ id: id, item: it });
    });
  }

  var state = { settings: null };

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || 'HTTP ' + r.status);
    return data;
  }

  function callPy(method, arg) {
    if (window.pywebview && window.pywebview.api && typeof window.pywebview.api[method] === 'function') {
      return window.pywebview.api[method](arg);
    }
    return null;
  }
  // 退出动画：先把八块收缩回圆心，播完再真正销毁窗口。
  // after 是销毁前要调的 pywebview 方法（比如 open_home / show_logs）。
  var closing = false;
  function closeRing(after) {
    if (closing) return;
    closing = true;
    var svg = document.getElementById('ring');
    if (svg) svg.classList.add('closing');
    setTimeout(function () {
      var r = after ? callPy(after[0], after[1]) : callPy('close');
      if (r === null) window.close();
    }, 190);
  }
  function showDetail(id) {
    closeRing(['show_logs', id]);
  }

  async function load() {
    try {
      var d = await api('/api/state');
      items = d.items || [];
      var s = await api('/api/settings');
      state.settings = s.settings || {};
      computeSlots();
      render();
    } catch (e) {
      var svg = document.getElementById('ring');
      svg.textContent = '';
      var t = el('text', { x: CX, y: CY, class: 'errmsg' });
      t.textContent = '连不上服务';
      svg.appendChild(t);
    }
  }

  function markBusy(id, on) {
    busy[id] = on;
    var g = document.querySelector('.slot[data-id="' + id + '"]');
    if (g) g.classList.toggle('busy', !!on);
  }

  async function openPage(item) {
    var url = (item.runtime && item.runtime.url) || item.url || '/s/' + item.id + '/';
    if (url.charAt(0) === '/') url = location.origin + url;
    await api('/api/open-window', { method: 'POST', body: JSON.stringify({ url: url }) });
  }

  async function activate(item) {
    var rt = item.runtime || {};

    if (item.kind === 'page') {
      try { await openPage(item); closeRing(); } catch (e) { markErr(item.id, e.message); }
      return;
    }
    if (rt.status === 'running') {
      if (item.kind === 'service' && (item.url || rt.url)) {
        try { await openPage(item); closeRing(); } catch (e) { markErr(item.id, e.message); }
      } else {
        closeRing();
      }
      return;
    }
    if (rt.status === 'starting' || busy[item.id]) return;

    markBusy(item.id, true);
    try {
      if (item.kind === 'service') {
        var r = await api('/api/items/' + item.id + '/start', { method: 'POST' });
        if (r.runtime && r.runtime.status === 'running') {
          closeRing();
        } else {
          markErr(item.id, '启动失败');
        }
      } else {
        await api('/api/items/' + item.id + '/run', { method: 'POST', body: '{}' });
        closeRing();
      }
    } catch (e) {
      markErr(item.id, e.message);
    } finally {
      markBusy(item.id, false);
    }
  }

  function markErr(id, msg) {
    var g = document.querySelector('.slot[data-id="' + id + '"]');
    if (!g) return;
    g.classList.add('err');
    var old = g.querySelector('.errmsg');
    if (old) old.remove();
    var pos = g.querySelector('g[transform]');
    var t = el('text', { class: 'errmsg', y: '30' });
    t.textContent = msg.length > 12 ? msg.slice(0, 12) + '\u2026' : msg;
    if (pos) pos.appendChild(t);
  }

  document.addEventListener('click', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.slot') : null;
    if (!g) return;
    var id = g.dataset.id;
    if (id === HOME) { closeRing(['open_home']); return; }
    var item = findItem(id);
    if (item) activate(item);
  });

  document.addEventListener('contextmenu', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.slot') : null;
    ev.preventDefault();
    if (!g) { closeRing(); return; }
    var id = g.dataset.id;
    if (id === HOME) { closeRing(); return; }
    showDetail(id);
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeRing();
  });

  // 失焦自动关闭也走同一个收缩动画。
  // Python 侧的失焦检测跑在子线程，调不了 evaluate_js（WebView2 的 COM 对象
  // 只能在 UI 线程访问），所以改由页面自己监听 blur —— 这样"失焦"和
  // "主动关闭"是同一条路径，都有动画。Python 那边的检测保留作兜底。
  var focusReady = false;
  setTimeout(function () { focusReady = true; }, 600);
  window.addEventListener('blur', function () {
    if (focusReady) closeRing();
  });

  load();
})();
`;

export function renderRing() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zen-Dock 快速启动</title>
<style>${RING_CSS}</style>
</head>
<body>
<svg id="ring" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet"></svg>
<script>${RING_JS}</script>
</body>
</html>`;
}

/** /dock 的入口：按设置分叉成圆环或面板。 */
export function renderDock(mode) {
  return mode === 'panel' ? renderPanelDock() : renderRing();
}
