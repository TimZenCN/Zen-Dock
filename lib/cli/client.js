// lib/cli/client.js —— CLI 与 hub 之间的通道
//
// 进程状态只活在 hub 的内存里（ServiceManager.rt），所以控制类命令必须走 HTTP，
// 不能自己 spawn —— 否则面板不知道、日志收不到、也停不掉。
// 配置类命令则直接读写 hub.config.json（hub 有 watch 热重载，会自己认到）。

import { loadConfig } from '../config.js';

const PROBE_TIMEOUT_MS = 600;

export class HubOfflineError extends Error {
  constructor(port) {
    super(`hub 没在跑（127.0.0.1:${port} 连不上）`);
    this.name = 'HubOfflineError';
    this.port = port;
  }
}

export class HubClient {
  constructor({ port = null, host = '127.0.0.1' } = {}) {
    this.host = host;
    this._port = port;
    this._online = null;
  }

  // 端口优先用命令行指定的，否则读配置文件里的
  async port() {
    if (this._port) return this._port;
    try {
      const cfg = await loadConfig();
      this._port = cfg.port || 7717;
    } catch {
      this._port = 7717;
    }
    return this._port;
  }

  async base() {
    return `http://${this.host}:${await this.port()}`;
  }

  async probe() {
    if (this._online !== null) return this._online;
    const base = await this.base();
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      this._online = res.ok;
    } catch {
      this._online = false;
    }
    return this._online;
  }

  async requireOnline() {
    if (await this.probe()) return;
    throw new HubOfflineError(await this.port());
  }

  async request(method, path, body) {
    await this.requireOnline();
    const base = await this.base();
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body === undefined ? {} : body);
  }

  del(path) {
    return this.request('DELETE', path);
  }

  // ---- 状态 ----

  async state() {
    return this.get('/api/state');
  }

  async item(id) {
    return this.get(`/api/items/${encodeURIComponent(id)}`);
  }

  async logs(id, since = 0) {
    const d = await this.get(`/api/items/${encodeURIComponent(id)}/logs?since=${since}`);
    return (d && d.lines) || [];
  }

  // ---- 动作 ----

  async start(id) {
    return this.post(`/api/items/${encodeURIComponent(id)}/start`);
  }

  async stop(id) {
    return this.post(`/api/items/${encodeURIComponent(id)}/stop`);
  }

  async run(id, values = {}) {
    return this.post(`/api/items/${encodeURIComponent(id)}/run`, { values });
  }

  async stopAll() {
    return this.post('/api/stop-all');
  }

  async openWindow(url) {
    return this.post('/api/open-window', { url });
  }

  async settings() {
    return this.get('/api/settings');
  }

  async saveSettings(patch) {
    return this.post('/api/settings', patch);
  }

  async autoStart(enabled) {
    return this.post('/api/autostart', { enabled });
  }

  async upsertItem(item) {
    return this.post('/api/items', item);
  }

  async removeItem(id) {
    return this.del(`/api/items/${encodeURIComponent(id)}`);
  }

  // ---- SSE ----

  // 逐帧解析 event-stream。返回异步生成器，调用方用 for await 消费。
  async *events(signal) {
    const base = await this.base();
    await this.requireOnline();
    const res = await fetch(`${base}/api/events`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`订阅事件失败：HTTP ${res.status}`);

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      // 帧之间用空行分隔，\n\n 和 \r\n\r\n 都要认
      let cut;
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, cut);
        const sepLen = buf.slice(cut).match(/^\r?\n\r?\n/)[0].length;
        buf = buf.slice(cut + sepLen);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  }

  // 跟日志。内部处理断线重连，回调式更好用（要自己控制退出条件）。
  async followLogs(id, onLine, { signal, maxRetries = 5 } = {}) {
    let retries = 0;
    while (!signal?.aborted) {
      try {
        for await (const frame of this.events(signal)) {
          retries = 0;
          if (frame.event !== 'log') continue;
          const entry = frame.data;
          if (!entry || entry.id !== id) continue;
          onLine(entry);
        }
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') return;
        if (e.name === 'HubOfflineError') throw e;
        retries += 1;
        if (retries > maxRetries) throw new Error(`日志流断开，重试 ${maxRetries} 次仍失败`);
        onLine({ id, stream: 'sys', text: `[zd] 连接中断，${retries}s 后重连…`, ts: Date.now() });
        await sleep(1000 * retries);
      }
    }
  }
}

function parseFrame(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // 空行和注释（: ping）都跳过
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  const joined = dataLines.join('\n');
  let data = joined;
  try {
    data = JSON.parse(joined);
  } catch {
    /* 非 JSON 的 data 原样返回 */
  }
  return { event, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function makeClient(opts = {}) {
  return new HubClient(opts);
}
