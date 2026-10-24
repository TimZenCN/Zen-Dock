// lib/scripts.js —— 一次性脚本：PowerShell / Python / BAT
//
// 编码策略：不主动 chcp。Windows 控制台程序默认按系统代码页（中文是 GBK）输出，
// logs.js 里 UTF-8 严格解码失败会自动回退 GBK，比强设 65001 更不容易翻车
// （设了 65001 反而会让 GBK 编码的 .bat 文件本身解析乱码）。
// Python 单独用 PYTHONUTF8=1 让它直接吐 UTF-8，加 -u 保证日志实时可见。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

export function buildArgs(item, values = {}) {
  const args = [...(item.args || [])];
  for (const p of item.params || []) {
    const raw = values?.[p.name] !== undefined ? values[p.name] : p.default;
    if (p.type === 'boolean') {
      if (raw === true || raw === 'true') args.push(p.flag);
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue;
    if (p.flag) args.push(p.flag);
    args.push(String(raw));
  }
  return args;
}

export function resolveShell(item, args) {
  const p = item.path;
  switch (item.shell) {
    case 'powershell':
      return {
        cmd: isWin ? 'powershell.exe' : 'pwsh',
        argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p, ...args],
        display: `powershell -File ${p} ${args.join(' ')}`.trim(),
      };
    case 'python': {
      const py = item.python || (isWin ? 'python' : 'python3');
      return {
        cmd: py,
        argv: ['-u', p, ...args],
        display: `${py} -u ${p} ${args.join(' ')}`.trim(),
      };
    }
    case 'bat': {
      if (!isWin) {
        return { cmd: 'sh', argv: [p, ...args], display: `sh ${p} ${args.join(' ')}`.trim() };
      }
      // 关键：不要手动给路径加引号，也不要用 /s。
      // Node 会按 CreateProcess 规则逐个转义参数，手动套一层引号会被再转义一次，
      // cmd 收到的是字面量引号，报「不是内部或外部命令」。
      return {
        cmd: 'cmd.exe',
        argv: ['/d', '/c', p, ...args],
        display: `cmd /c ${p} ${args.join(' ')}`.trim(),
      };
    }
    default:
      throw new Error(`不支持的 shell: ${item.shell}`);
  }
}

export class ScriptRunner extends EventEmitter {
  constructor({ config, logs }) {
    super();
    this.config = config;
    this.logs = logs;
    this.rt = new Map(); // id -> { status, pid, startedAt, exitCode, lastRunAt }
    this.children = new Map();
  }

  get(id) {
    return this.rt.get(id) || { status: 'idle', pid: null, startedAt: null, exitCode: null, lastRunAt: null };
  }

  snapshot() {
    const out = {};
    for (const [id, st] of this.rt) {
      out[id] = { ...st, uptimeMs: st.startedAt ? Date.now() - st.startedAt : null };
    }
    return out;
  }

  syncItems() {
    const ids = new Set(this.config.items.filter((i) => i.kind === 'script').map((i) => i.id));
    for (const id of [...this.rt.keys()]) if (!ids.has(id)) this.rt.delete(id);
  }

  set(id, patch) {
    const next = { ...this.get(id), ...patch };
    this.rt.set(id, next);
    this.emit('change', { id, ...next });
  }

  async run(item, values = {}) {
    const cur = this.get(item.id);
    if (cur.status === 'running') throw new Error('这个脚本还在跑，先停掉或等它结束');

    const args = buildArgs(item, values);
    const { cmd, argv, display } = resolveShell(item, args);

    this.logs.clear(item.id);
    this.logs.append(item.id, 'sys', `$ ${display}`);
    if (item.cwd) this.logs.append(item.id, 'sys', `cwd: ${item.cwd}`);

    const env = { ...process.env, ...(item.env || {}) };
    if (item.shell === 'python') {
      env.PYTHONUTF8 = '1';
      env.PYTHONIOENCODING = 'utf-8';
      env.PYTHONUNBUFFERED = '1';
    }

    let child;
    try {
      child = spawn(cmd, argv, {
        cwd: item.cwd || undefined,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.logs.append(item.id, 'err', `启动失败：${e.message}`);
      this.set(item.id, { status: 'failed', pid: null, exitCode: null, lastRunAt: Date.now() });
      throw e;
    }

    this.children.set(item.id, child);
    this.set(item.id, {
      status: 'running',
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitCode: null,
      lastRunAt: Date.now(),
    });

    child.stdout?.on('data', (b) => this.logs.write(item.id, 'out', b));
    child.stderr?.on('data', (b) => this.logs.write(item.id, 'err', b));

    child.on('error', (e) => {
      this.logs.append(item.id, 'err', `进程错误：${e.message}`);
      this.logs.flush(item.id);
      this.set(item.id, { status: 'failed', pid: null });
    });

    child.on('exit', (code) => {
      this.children.delete(item.id);
      this.logs.flush(item.id);
      this.logs.append(item.id, 'sys', `结束，退出码 ${code}`);
      this.set(item.id, {
        status: code === 0 ? 'done' : 'failed',
        pid: null,
        exitCode: code,
      });
    });

    return this.get(item.id);
  }

  async stop(id) {
    const child = this.children.get(id);
    const st = this.get(id);
    const pid = child?.pid ?? st.pid;
    if (!pid) return;
    try {
      if (isWin) {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (e) {
      this.logs.append(id, 'sys', `停止失败：${e.message}`);
    }
  }
}
