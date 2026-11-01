// lib/logs.js —— 每项一个环形缓冲 + 事件广播 + 落盘
// 子进程输出是 Buffer，可能被多字节字符切断，所以按字节找 \n 再解码。
// Windows 上 cmd / bat 输出常是 GBK，UTF-8 严格解码失败就回退 GBK。
//
// 落盘的理由：内存缓冲在 hub 重启后就没了，而"服务崩了要翻日志"恰恰是
// 重启前后那一段。所以同一份内容既进内存（给 SSE 用）也进文件（给人用）。

import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbk = new TextDecoder('gbk');

export function decodeBuffer(buf) {
  try {
    return utf8Strict.decode(buf);
  } catch {
    return gbk.decode(buf);
  }
}

const MAX_PENDING = 64 * 1024;

// 单文件上限。超过就轮转成 .log.1（覆盖旧的），只留一代。
// 留一代足够定位"上次崩在哪"，再多就是占空间。
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 本地时间 YYYY-MM-DD HH:mm:ss.SSS，给人看的 */
function stamp(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** id 来自配置文件，理论上安全，但不该让 `../` 之类的东西落到日志目录外 */
function safeName(id) {
  return String(id).replace(/[^\w.-]/g, '_').slice(0, 80) || 'item';
}

/**
 * 一个 item 的日志文件。
 *
 * 用「攒一批 + setImmediate 刷一次」而不是每条 appendFileSync：
 * 构建脚本一次能吐几千行，逐条同步写会把事件循环卡住。
 * 攒一帧的代价是进程被 taskkill /F 时最多丢最后几毫秒的日志 —— 可以接受。
 */
class LogFile {
  constructor(dir, id, maxBytes) {
    this.path = path.join(dir, `${safeName(id)}.log`);
    this.rotated = `${this.path}.1`;
    this.maxBytes = maxBytes;
    this.pending = [];
    this.scheduled = false;
    this.bytes = -1; // -1 = 还没 stat 过
    this.broken = null; // 写失败后记下原因，之后静默跳过
    this.dir = dir;
  }

  write(line) {
    if (this.broken) return;
    this.pending.push(line);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  flush() {
    this.scheduled = false;
    if (!this.pending.length) return;
    // 一次 join 一次转 Buffer，正常情况只 syscall 一次
    let buf = Buffer.from(this.pending.join(''));
    this.pending = [];

    try {
      if (this.bytes < 0) {
        mkdirSync(this.dir, { recursive: true });
        this.bytes = existsSync(this.path) ? statSync(this.path).size : 0;
      }

      // 一批数据本身就超过上限时（构建脚本一口气吐几千行），按上限分段写，
      // 写满就轮转。只留一代，所以数据量超过两倍上限时最旧的部分会被丢掉 ——
      // 日志不是数据库，保最近的够定位问题就行。
      while (buf.length) {
        if (this.bytes >= this.maxBytes) this._rotate();
        const room = this.maxBytes - this.bytes;
        if (buf.length <= room) {
          appendFileSync(this.path, buf);
          this.bytes += buf.length;
          break;
        }
        // 切在 room 字节处，但要避开 UTF-8 续字节（0b10xxxxxx），
        // 否则中文会被劈成两半，文件里出现乱码
        let cut = room;
        while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
        if (cut <= 0) cut = room;
        appendFileSync(this.path, buf.subarray(0, cut));
        this.bytes += cut;
        buf = buf.subarray(cut);
      }
    } catch (e) {
      // 磁盘满、权限不足之类。日志写不了不能影响服务本身，只记一次。
      this.broken = `${e.code || e.name}: ${e.message}`;
      this.emitBroken();
    }
  }

  _rotate() {
    try {
      rmSync(this.rotated, { force: true });
      renameSync(this.path, this.rotated);
    } catch {
      // rename 失败（被别的程序占着）就继续往原文件追加，别让日志断了
    }
    this.bytes = 0;
  }

  emitBroken() {
    if (this.onBroken) this.onBroken(this.broken);
  }

  /** 清空 = 内存和文件一起清，符合"清空日志"的直觉 */
  clear() {
    this.pending = [];
    if (this.broken) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, '');
      this.bytes = 0;
    } catch (e) {
      this.broken = `${e.code || e.name}: ${e.message}`;
    }
  }

  /** 进程正常退出前把没刷的刷掉 */
  close() {
    if (this.scheduled) this.flush();
  }
}

export class LogStore extends EventEmitter {
  /**
   * @param {object} opt
   * @param {number} [opt.maxLines=500]  内存里每项保留几行（给 SSE 回放用）
   * @param {string|null} [opt.dir=null] 落盘目录，null = 只进内存
   * @param {number} [opt.maxBytes]      单文件上限，超过轮转
   */
  constructor({ maxLines = 500, dir = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    super();
    this.maxLines = maxLines;
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.buffers = new Map(); // id -> entry[]
    this.pending = new Map(); // "id:stream" -> Buffer
    this.seq = new Map(); // id -> number
    this.files = new Map(); // id -> LogFile
  }

  lines(id) {
    return this.buffers.get(id) || [];
  }

  /** 某个 item 的日志文件路径，没开落盘时返回 null */
  fileOf(id) {
    if (!this.dir) return null;
    return this._file(id).path;
  }

  _file(id) {
    let f = this.files.get(id);
    if (!f) {
      f = new LogFile(this.dir, id, this.maxBytes);
      f.onBroken = (why) => {
        // 只广播一次，避免每行都报
        this.emit('file-error', { id, why });
      };
      this.files.set(id, f);
    }
    return f;
  }

  append(id, stream, text) {
    const list = this.buffers.get(id) || [];
    const seq = (this.seq.get(id) || 0) + 1;
    this.seq.set(id, seq);
    const entry = { id, seq, ts: Date.now(), stream, text };
    list.push(entry);
    if (list.length > this.maxLines) list.splice(0, list.length - this.maxLines);
    this.buffers.set(id, list);

    if (this.dir) {
      // sys / out / err 三个来源在文件里也要能区分，否则分不清哪句是 hub 自己写的
      this._file(id).write(`${stamp(entry.ts)} [${stream}] ${text}\n`);
    }

    this.emit('log', entry);
    return entry;
  }

  // 把一块原始输出按行拆开写进缓冲
  write(id, stream, chunk) {
    const key = `${id}:${stream}`;
    const prev = this.pending.get(key) || Buffer.alloc(0);
    const buf = prev.length ? Buffer.concat([prev, chunk]) : chunk;

    const cuts = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        cuts.push(buf.subarray(start, i));
        start = i + 1;
      }
    }
    let rest = buf.subarray(start);

    // 长时间没有换行的输出（比如进度条）别无限堆积
    if (rest.length > MAX_PENDING) {
      cuts.push(rest);
      rest = Buffer.alloc(0);
    }
    this.pending.set(key, rest);

    for (const piece of cuts) {
      this.append(id, stream, decodeBuffer(piece).replace(/\r$/, ''));
    }
  }

  // 进程退出时把残留的半行吐出来
  flush(id) {
    for (const stream of ['out', 'err']) {
      const key = `${id}:${stream}`;
      const rest = this.pending.get(key);
      if (rest && rest.length) {
        this.append(id, stream, decodeBuffer(rest).replace(/\r$/, ''));
      }
      this.pending.delete(key);
    }
  }

  clear(id) {
    this.buffers.delete(id);
    this.seq.delete(id);
    this.pending.delete(`${id}:out`);
    this.pending.delete(`${id}:err`);
    const f = this.files.get(id);
    if (f) f.clear();
    this.emit('cleared', { id });
  }

  /** 进程退出前调用：把攒着的写完 */
  close() {
    for (const f of this.files.values()) f.close();
  }

  since(id, sinceSeq = 0) {
    return this.lines(id).filter((e) => e.seq > sinceSeq);
  }
}
