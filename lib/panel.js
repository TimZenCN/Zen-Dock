// lib/panel.js —— 管理页（内联 HTML + CSS + JS，无构建步骤）
// 客户端渲染全部用 createElement + textContent，配置里的名字带尖括号也不会出问题。

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#0b0e14;--panel:#12161f;--card:#161b26;--line:#232a38;--line2:#2f3949;
  --text:#dfe6f0;--muted:#7d8799;--dim:#5a6474;
  --green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bg);border-bottom:1px solid var(--line)}
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
@media(max-width:980px){#grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){#grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:.12s}
.card:hover{border-color:#39445a;background:#182030}
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
#settings{position:fixed;top:0;right:0;bottom:0;width:min(520px,92vw);background:var(--panel);border-left:1px solid var(--line2);transform:translateX(101%);transition:transform .2s ease;z-index:55;display:flex;flex-direction:column}
#settings.on{transform:translateX(0)}
.sbody{flex:1;overflow:auto;padding:16px}
.sbody section{margin-bottom:22px}
.sbody h4{margin:0 0 10px;font-size:12px;font-weight:500;color:var(--muted);letter-spacing:.04em}
.opt{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer}
.opt:hover{border-color:var(--line2);background:#141a24}
.opt input{margin:2px 0 0;flex:none}
.opt .txt{display:flex;flex-direction:column;gap:2px}
.opt .txt b{font-size:12px;font-weight:500}
.opt .txt span{font-size:11px;color:var(--dim);line-height:1.5}
.badge{font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--line2);color:var(--dim)}
.badge.on{color:#7ee787;border-color:#2b5c34;background:#132a19}
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
      if (item.url) out.push(['open', '打开页面', '']);
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
    if (addBtn) grid.appendChild(addBtn);
  }

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
    if (item.url || item.kind === 'page') {
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
        var url = item.url || ('/s/' + id + '/');
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
    } else if (st.enabled) {
      hint.textContent = '注册表里现在是：' + (st.command || 'Zen-Dock');
    } else {
      hint.textContent = '勾上会写入 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run，取消就删掉。';
    }
  }

  async function openSettings() {
    closeMenu();
    closeDrawer();
    $('#settings').classList.add('on');
    $('#overlay').classList.add('on');
    fillSettings();
    $('#aboutInfo').textContent =
      'Zen-Dock 0.1.0 · 服务 ' + location.origin + ' · 配置 hub.config.json';
    try {
      var d = await api('/api/settings');
      state.settings = d.settings;
      state.autoStart = d.autoStart;
      fillSettings();
      renderAutoStart(d.autoStart);
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
      toast(enabled ? '已注册开机自启' : '已取消开机自启');
    } catch (e) {
      toast(e.message);
      $('#autoStartBox').checked = !enabled;
    }
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
<header>
  <div class="brand">Zen-Dock<small>本地服务面板</small></div>
  <div class="spacer"></div>
  <button id="addBtn">+ 添加</button>
  <button id="settingsBtn">设置</button>
  <button id="stopAll" class="danger">全停</button>
</header>
<main id="grid"></main>

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
  <div class="sbody">
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
    <section>
      <h4>开机自启 <span class="badge" id="autoStartBadge">检查中</span></h4>
      <label class="opt">
        <input type="checkbox" id="autoStartBox">
        <span class="txt"><b>开机时自动启动 Zen-Dock</b><span>写进 HKCU 的 Run 键，不需要管理员权限</span></span>
      </label>
      <p class="hint" id="autoStartHint"></p>
    </section>
    <section>
      <h4>关于</h4>
      <p class="hint" id="aboutInfo"></p>
    </section>
  </div>
</aside>

<div id="modal"><div class="mbox" id="mbox"></div></div>
<div id="toast" style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1d2534;border:1px solid #3a4557;color:#dfe6f0;padding:9px 16px;border-radius:8px;font-size:12px;opacity:0;transition:.2s;pointer-events:none;z-index:80"></div>

<script>${CLIENT_JS}</script>
</body>
</html>`;
}
