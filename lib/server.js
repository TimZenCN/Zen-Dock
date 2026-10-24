// lib/server.js —— HTTP 路由
//
// 安全模型：只绑 127.0.0.1，另外校验 Origin 和 Sec-Fetch-Site。
// 后者很重要——你开着的任何网页都能 fetch('http://127.0.0.1:7717/api/...')，
// 没有这层校验等于给所有网站开了个能跑脚本的后门。

import http from 'node:http';
import { watch } from 'node:fs';
import { renderPanel } from './panel.js';
import { serveSite } from './sites.js';
import { openInBrowser, revealPath, getAutoStart, setAutoStart } from './system.js';
import {
  findItem,
  upsertItem,
  removeItem,
  saveConfig,
  loadConfig,
  validateItem,
  resolveLocal,
  CONFIG_PATH,
} from './config.js';

const MAX_BODY = 1 << 20; // 1MB

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`JSON 解析失败：${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createHub({ config, services, scripts, logs }) {
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  logs.on('log', (entry) => broadcast('log', entry));
  logs.on('cleared', (e) => broadcast('cleared', e));
  services.on('change', (s) => broadcast('state', { kind: 'service', ...s }));
  scripts.on('change', (s) => broadcast('state', { kind: 'script', ...s }));

  function runtimeOf(item) {
    if (item.kind === 'service') return services.get(item.id);
    if (item.kind === 'script') return scripts.get(item.id);
    return null;
  }

  function statePayload() {
    return {
      hub: { port: config.port, host: config.host, logLines: config.logLines },
      settings: config.settings,
      items: config.items.map((it) => ({ ...it, runtime: runtimeOf(it) })),
    };
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        const hostOk = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
        const portOk = !u.port || Number(u.port) === config.port;
        if (!hostOk || !portOk) return false;
      } catch {
        return false;
      }
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return true;
  }

  async function reloadConfig() {
    try {
      const fresh = await loadConfig();
      Object.assign(config, fresh);
      services.syncItems();
      scripts.syncItems();
      broadcast('config', { items: config.items.length });
      console.log(`[config] 已重新加载，${config.items.length} 项`);
    } catch (e) {
      console.error(`[config] 重载失败：${e.message}`);
      broadcast('config-error', { message: e.message });
    }
  }

  let watchTimer = null;
  try {
    watch(CONFIG_PATH, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(reloadConfig, 250);
    });
  } catch {
    /* 监听失败不影响主流程 */
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (!originOk(req)) {
      return json(res, 403, { error: '跨站请求被拒绝' });
    }

    // 静态站点 /s/<id>/...
    if (seg[0] === 's' && seg[1]) {
      const item = findItem(config, seg[1]);
      if (!item || item.kind !== 'page') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 没有这个页面项');
      }
      const sub = '/' + seg.slice(2).join('/');
      return serveSite(item, sub, res);
    }

    if (seg[0] === 'health') return json(res, 200, { ok: true, uptime: process.uptime() });

    if (seg[0] !== 'api') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = renderPanel(config);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        return res.end(html);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }

    // ---- /api/state ----
    if (seg[1] === 'state' && method === 'GET') {
      return json(res, 200, statePayload());
    }

    // ---- /api/events (SSE) ----
    if (seg[1] === 'events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    // ---- /api/settings ----
    if (seg[1] === 'settings') {
      if (method === 'GET') {
        return json(res, 200, { settings: config.settings, autoStart: await getAutoStart() });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const next = { ...config.settings, ...body };
        if (next.openMode && !['window', 'app'].includes(next.openMode)) {
          return json(res, 400, { error: 'openMode 只能是 window 或 app' });
        }
        if (next.closeAction && !['quit', 'tray'].includes(next.closeAction)) {
          return json(res, 400, { error: 'closeAction 只能是 quit 或 tray' });
        }
        config.settings = next;
        await saveConfig(config);
        broadcast('config', { items: config.items.length });
        return json(res, 200, { ok: true, settings: config.settings });
      }
    }

    // ---- /api/open-window ----
    if (seg[1] === 'open-window' && method === 'POST') {
      const body = await readJson(req);
      if (!body.url) return json(res, 400, { error: '缺少 url' });
      const mode = body.mode || config.settings.openMode || 'window';
      try {
        return json(res, 200, { ok: true, ...openInBrowser(body.url, mode) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---- /api/autostart ----
    if (seg[1] === 'autostart') {
      if (method === 'GET') return json(res, 200, await getAutoStart());
      if (method === 'POST') {
        const body = await readJson(req);
        try {
          const st = await setAutoStart(!!body.enabled);
          config.settings.autoStart = !!body.enabled;
          await saveConfig(config);
          return json(res, 200, st);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
    }

    // ---- /api/stop-all ----
    if (seg[1] === 'stop-all' && method === 'POST') {
      const results = await services.stopAll();
      for (const [id, st] of scripts.rt) {
        if (st.status === 'running') await scripts.stop(id);
      }
      return json(res, 200, { ok: true, stopped: results.length });
    }

    // ---- /api/items ----
    if (seg[1] === 'items') {
      // POST /api/items  → 新增或更新
      if (!seg[2] && method === 'POST') {
        const body = await readJson(req);
        const errs = validateItem(body, new Set(config.items.filter((i) => i.id !== body.id).map((i) => i.id)));
        if (errs.length) return json(res, 400, { error: errs.join('；') });
        upsertItem(config, body);
        await saveConfig(config);
        services.syncItems();
        scripts.syncItems();
        broadcast('config', { items: config.items.length });
        return json(res, 200, { ok: true, item: findItem(config, body.id) });
      }

      // DELETE /api/items/:id
      if (seg[2] && !seg[3] && method === 'DELETE') {
        const id = seg[2];
        const item = findItem(config, id);
        if (!item) return json(res, 404, { error: '没有这个 item' });
        if (item.kind === 'service') await services.stop(id);
        if (item.kind === 'script') await scripts.stop(id);
        removeItem(config, id);
        await saveConfig(config);
        services.syncItems();
        scripts.syncItems();
        logs.clear(id);
        broadcast('config', { items: config.items.length });
        return json(res, 200, { ok: true });
      }

      const id = seg[2];
      const action = seg[3];
      const item = id ? findItem(config, id) : null;
      if (id && !action && method === 'GET') {
        if (!item) return json(res, 404, { error: '没有这个 item' });
        return json(res, 200, { ...item, runtime: runtimeOf(item) });
      }
      if (!item) return json(res, 404, { error: '没有这个 item' });

      // GET /api/items/:id/logs?since=N
      if (action === 'logs' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        return json(res, 200, { lines: logs.since(id, since) });
      }

      if (action === 'start' && method === 'POST') {
        if (item.kind !== 'service') return json(res, 400, { error: '只有 service 能这样启动' });
        try {
          const st = await services.start(item);
          return json(res, 200, { ok: true, runtime: st });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (action === 'stop' && method === 'POST') {
        if (item.kind === 'service') {
          await services.stop(id);
        } else if (item.kind === 'script') {
          await scripts.stop(id);
        } else {
          return json(res, 400, { error: '这个 item 不能停止' });
        }
        return json(res, 200, { ok: true });
      }

      if (action === 'run' && method === 'POST') {
        if (item.kind !== 'script') return json(res, 400, { error: '只有 script 能运行' });
        const body = await readJson(req);
        try {
          const st = await scripts.run(item, body.values || {});
          return json(res, 200, { ok: true, runtime: st });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (action === 'clear-logs' && method === 'POST') {
        logs.clear(id);
        return json(res, 200, { ok: true });
      }

      if (action === 'reveal' && method === 'POST') {
        // 脚本定位到文件本身（explorer /select 会选中它），服务和页面定位到目录
        const target = item.kind === 'script' ? item.path : item.cwd || item.dir;
        try {
          return json(res, 200, { ok: true, ...(await revealPath(resolveLocal(target))) });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
    }

    return json(res, 404, { error: `没有这个接口：${method} ${url.pathname}` });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[http]', e);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    });
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () => {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      return new Promise((r) => server.close(r));
    },
  };
}
