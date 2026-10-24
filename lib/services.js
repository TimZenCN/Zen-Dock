// lib/services.js —— 常驻进程：启动、探活、强杀、接管
//
// Windows 上没有优雅停止：SIGTERM 等于 TerminateProcess，taskkill 不带 /F 发的是
// WM_CLOSE（只对 GUI 窗口有效）。所以「停止」就是 taskkill /T /F 杀整棵进程树。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { loadState, saveState, resolveLocal } from './config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function probePort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// 按端口反查监听进程（Windows: netstat -ano）
export async function findPidByPort(port) {
  if (!isWin) {
    try {
      const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN']);
      const pid = parseInt(stdout.trim().split('\n')[0], 10);
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
      if (!cols[1].endsWith(`:${port}`)) continue;
      if (cols[3].toUpperCase() !== 'LISTENING') continue;
      const pid = Number(cols[4]);
      if (Number.isInteger(pid)) return pid;
    }
  } catch {
    /* netstat 拿不到就放弃 */
  }
  return null;
}

export class ServiceManager extends EventEmitter {
  constructor({ config, logs }) {
    super();
    this.config = config;
    this.logs = logs;
    this.rt = new Map(); // id -> status object
    this.tokens = new Map(); // id -> 启动代次，用于打断过期的探活循环
    this.children = new Map(); // id -> ChildProcess
    this.urlRes = new Map(); // id -> RegExp（urlFrom 编译结果）

    // 有些服务的真实地址要等它自己打印出来才知道（典型是带一次性 token 的 URL）。
    // 配了 urlFrom 就在输出里抓，抓到存进 runtime.url，卡片的「打开页面」优先用它。
    this.logs.on('log', (entry) => this.captureUrl(entry));
  }

  captureUrl(entry) {
    if (entry.stream === 'sys') return;
    const item = this.config.items.find((i) => i.id === entry.id);
    if (!item || item.kind !== 'service' || !item.urlFrom) return;

    let re = this.urlRes.get(item.id);
    if (re === undefined) {
      try {
        re = new RegExp(item.urlFrom);
      } catch (e) {
        re = null;
        this.logs.append(item.id, 'err', `urlFrom 正则无效：${e.message}`);
      }
      this.urlRes.set(item.id, re);
    }
    if (!re) return;

    const m = re.exec(entry.text);
    if (!m) return;
    const url = (m[1] || m[0] || '').trim();
    if (!/^https?:\/\//.test(url)) return;
    if (this.get(entry.id).url === url) return; // 没变就不 emit，省一次全量刷新
    this.set(entry.id, { url });
  }

  blank(status = 'stopped') {
    return {
      status,
      pid: null,
      startedAt: null,
      exitCode: null,
      external: false,
      port: null,
      expectExit: false,
      url: null, // 从输出里抓到的真实地址（urlFrom），没配就一直是 null
    };
  }

  ensure(item) {
    if (!this.rt.has(item.id)) this.rt.set(item.id, this.blank());
    return this.rt.get(item.id);
  }

  get(id) {
    return this.rt.get(id) || this.blank();
  }

  snapshot() {
    const out = {};
    for (const [id, st] of this.rt) {
      out[id] = { ...st, uptimeMs: st.startedAt ? Date.now() - st.startedAt : null };
    }
    return out;
  }

  set(id, patch) {
    const cur = this.get(id);
    const next = { ...cur, ...patch };
    this.rt.set(id, next);
    this.emit('change', { id, ...next });
    this.persist();
  }

  // 配置热重载后同步：新增的补空状态，删掉的清掉
  syncItems() {
    const ids = new Set(this.config.items.filter((i) => i.kind === 'service').map((i) => i.id));
    for (const id of ids) if (!this.rt.has(id)) this.rt.set(id, this.blank());
    for (const id of [...this.rt.keys()]) if (!ids.has(id)) this.rt.delete(id);
    for (const id of [...this.urlRes.keys()]) if (!ids.has(id)) this.urlRes.delete(id);
  }

  async persist() {
    const state = {};
    for (const [id, st] of this.rt) {
      if (st.pid && st.status !== 'stopped') {
        state[id] = { pid: st.pid, startedAt: st.startedAt };
      }
    }
    try {
      await saveState(state);
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  // 启动时把上次遗留的进程认回来
  async init() {
    for (const item of this.config.items) {
      if (item.kind === 'service') this.rt.set(item.id, this.blank());
    }
    const saved = await loadState();
    for (const item of this.config.items) {
      if (item.kind !== 'service') continue;
      const rec = saved[item.id];
      let pid = rec?.pid ?? null;
      let alive = isPidAlive(pid);
      let external = true;

      if (!alive && item.port) {
        const byPort = await findPidByPort(item.port);
        if (byPort) {
          pid = byPort;
          alive = true;
        }
      }
      if (!alive) continue;

      const listening = item.port ? await probePort(item.port) : true;
      this.rt.set(item.id, {
        ...this.blank(listening ? 'running' : 'starting'),
        pid,
        startedAt: rec?.startedAt ?? Date.now(),
        external,
        port: item.port ?? null,
      });
      this.logs.append(
        item.id,
        'sys',
        `接管已在运行的进程 pid=${pid}（不是本实例启动的，停止时会强杀整棵进程树）`
      );
    }
    this.persist();
  }

  async start(item) {
    const cur = this.get(item.id);
    if (cur.status === 'running' || cur.status === 'starting') {
      throw new Error('已经在运行了');
    }
    if (item.port && (await probePort(item.port))) {
      const pid = await findPidByPort(item.port);
      throw new Error(`端口 ${item.port} 已被占用${pid ? `（pid ${pid}）` : ''}，先停掉它或改端口`);
    }

    const token = (this.tokens.get(item.id) || 0) + 1;
    this.tokens.set(item.id, token);

    const args = item.args ?? [];
    this.logs.append(item.id, 'sys', `$ ${item.cmd} ${args.join(' ')}`.trim());
    this.logs.append(item.id, 'sys', `cwd: ${resolveLocal(item.cwd) || process.cwd()}`);

    let child;
    try {
      child = spawn(item.cmd, args, {
        cwd: resolveLocal(item.cwd) || undefined,
        env: { ...process.env, ...(item.env || {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.logs.append(item.id, 'err', `spawn 失败：${e.message}`);
      this.set(item.id, { ...this.blank('failed'), exitCode: null });
      throw e;
    }

    this.children.set(item.id, child);
    this.set(item.id, {
      status: 'starting',
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitCode: null,
      external: false,
      port: item.port ?? null,
      expectExit: false,
    });

    child.stdout?.on('data', (b) => this.logs.write(item.id, 'out', b));
    child.stderr?.on('data', (b) => this.logs.write(item.id, 'err', b));

    child.on('error', (e) => {
      this.logs.append(item.id, 'err', `进程错误：${e.message}`);
      this.logs.flush(item.id);
      this.set(item.id, { ...this.blank('failed'), exitCode: null });
    });

    child.on('exit', (code, signal) => {
      this.children.delete(item.id);
      this.logs.flush(item.id);
      this.logs.append(
        item.id,
        'sys',
        `进程退出 code=${code}${signal ? ` signal=${signal}` : ''}`
      );
      if (this.tokens.get(item.id) !== token) return; // 已被新的启动取代
      const st = this.get(item.id);
      // expectExit 是主动停止的标记。taskkill 的退出码不是 0，但这是预期内的，
      // 不能记成 crashed——否则点「停止」之后卡片会变红。
      const stoppedByUser = st.expectExit || st.status === 'stopping';
      this.set(item.id, {
        ...this.blank(stoppedByUser || code === 0 ? 'stopped' : 'crashed'),
        exitCode: code,
      });
    });

    if (!item.port) {
      await sleep(400);
      if (this.tokens.get(item.id) === token && isPidAlive(child.pid)) {
        this.set(item.id, { status: 'running' });
      }
      return this.get(item.id);
    }

    const timeout = item.startTimeoutMs ?? this.config.startTimeoutMs ?? 15000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.tokens.get(item.id) !== token) return this.get(item.id);
      if (this.get(item.id).status === 'crashed' || this.get(item.id).status === 'failed') {
        return this.get(item.id);
      }
      if (!isPidAlive(child.pid)) {
        this.logs.append(item.id, 'err', `进程在探活前就退出了（pid ${child.pid}）`);
        this.set(item.id, { ...this.blank('failed') });
        return this.get(item.id);
      }
      if (await probePort(item.port)) {
        this.logs.append(item.id, 'sys', `端口 ${item.port} 已就绪，用时 ${Date.now() - (deadline - timeout)}ms`);
        this.set(item.id, { status: 'running' });

        // 端口通了不代表地址已经打印出来（dsh web 就晚 7 秒左右）。
        // 配了 urlFrom 的服务在这里等一小会儿，免得用户刚看到变绿就点「打开页面」撞 401。
        if (item.urlFrom) {
          const waitMs = item.urlWaitMs ?? 10000;
          const urlDeadline = Date.now() + waitMs;
          while (Date.now() < urlDeadline) {
            if (this.get(item.id).url) break;
            if (this.tokens.get(item.id) !== token) break;
            await sleep(200);
          }
          if (!this.get(item.id).url) {
            this.logs.append(item.id, 'sys', `urlFrom 在 ${waitMs}ms 内没匹配到，先用兜底地址`);
          }
        }
        return this.get(item.id);
      }
      await sleep(300);
    }

    this.logs.append(item.id, 'err', `启动超时：${timeout}ms 内端口 ${item.port} 未就绪`);
    this.set(item.id, { ...this.blank('failed'), pid: child.pid ?? null });
    return this.get(item.id);
  }

  async stop(id) {
    const st = this.get(id);
    if (!st.pid) {
      this.set(id, this.blank('stopped'));
      return;
    }
    this.set(id, { status: 'stopping', expectExit: true });
    this.logs.append(id, 'sys', `taskkill /PID ${st.pid} /T /F`);

    try {
      if (isWin) {
        await execFileAsync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(st.pid, 'SIGTERM');
        await sleep(1200);
        if (isPidAlive(st.pid)) process.kill(st.pid, 'SIGKILL');
      }
    } catch (e) {
      this.logs.append(id, 'sys', `taskkill 报错（进程可能已退出）：${e.message}`);
    }

    this.logs.flush(id);
    if (this.get(id).status !== 'stopped') {
      // 保留 expectExit：taskkill 的退出事件可能晚于这里返回，
      // 留着标记让 exit handler 知道这是主动停止，不要记成 crashed。
      this.set(id, { ...this.blank('stopped'), expectExit: true });
    }
  }

  async stopAll() {
    const results = [];
    for (const [id, st] of this.rt) {
      if (st.pid) results.push({ id, result: await this.stop(id) });
    }
    return results;
  }

  async shutdown() {
    // 退出前不杀子进程，交给 state.json 下次接管
    await this.persist();
  }
}
