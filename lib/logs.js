// lib/logs.js —— 每项一个环形缓冲 + 事件广播
// 子进程输出是 Buffer，可能被多字节字符切断，所以按字节找 \n 再解码。
// Windows 上 cmd / bat 输出常是 GBK，UTF-8 严格解码失败就回退 GBK。

import { EventEmitter } from 'node:events';

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

export class LogStore extends EventEmitter {
  constructor({ maxLines = 500 } = {}) {
    super();
    this.maxLines = maxLines;
    this.buffers = new Map(); // id -> entry[]
    this.pending = new Map(); // "id:stream" -> Buffer
    this.seq = new Map(); // id -> number
  }

  lines(id) {
    return this.buffers.get(id) || [];
  }

  append(id, stream, text) {
    const list = this.buffers.get(id) || [];
    const seq = (this.seq.get(id) || 0) + 1;
    this.seq.set(id, seq);
    const entry = { id, seq, ts: Date.now(), stream, text };
    list.push(entry);
    if (list.length > this.maxLines) list.splice(0, list.length - this.maxLines);
    this.buffers.set(id, list);
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
    this.emit('cleared', { id });
  }

  since(id, sinceSeq = 0) {
    return this.lines(id).filter((e) => e.seq > sinceSeq);
  }
}
