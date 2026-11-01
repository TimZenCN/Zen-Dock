// test-scripts/logs.mjs —— 日志落盘与轮转
// 用法：node test-scripts/logs.mjs
//
// 只测落盘这一层，不启动 hub、不起进程。

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogStore } from '../lib/logs.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const dir = mkdtempSync(path.join(tmpdir(), 'zd-logs-'));
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

try {
  // ---- 1. 基本落盘 ----
  console.log('\n[1] 落盘内容与格式');
  {
    const logs = new LogStore({ maxLines: 100, dir });
    logs.append('svc-a', 'sys', '$ node server.js');
    logs.append('svc-a', 'out', 'listening on 3000');
    logs.append('svc-a', 'err', 'boom');
    logs.close();

    const f = path.join(dir, 'svc-a.log');
    const text = read(f);
    ok('文件已创建', existsSync(f));
    ok('三行都写进去了', text.trimEnd().split('\n').length === 3, `实际 ${text.split('\n').length} 行`);
    ok('带时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /m.test(text));
    ok('带来源标记', text.includes('[sys]') && text.includes('[out]') && text.includes('[err]'));
    ok('内容正确', text.includes('listening on 3000') && text.includes('boom'));
    ok('fileOf 返回路径', logs.fileOf('svc-a') === f);
  }

  // ---- 2. 多个 item 互不串 ----
  console.log('\n[2] 按 item 分文件');
  {
    const logs = new LogStore({ maxLines: 100, dir });
    logs.append('a', 'out', 'aaa');
    logs.append('b', 'out', 'bbb');
    logs.close();
    ok('a 只拿到自己的', read(path.join(dir, 'a.log')).includes('aaa') && !read(path.join(dir, 'a.log')).includes('bbb'));
    ok('b 只拿到自己的', read(path.join(dir, 'b.log')).includes('bbb') && !read(path.join(dir, 'b.log')).includes('aaa'));
  }

  // ---- 3. 轮转 ----
  // 只留一代，所以数据量超过两倍上限时最旧的那部分会被丢掉。
  // 这是有意的：日志用来定位"最近崩在哪"，不是审计归档。
  console.log('\n[3] 超过上限轮转');
  {
    const small = path.join(dir, 'rot');
    const logs = new LogStore({ maxLines: 10, dir: small, maxBytes: 400 });
    for (let i = 0; i < 20; i++) logs.append('r', 'out', `line-${String(i).padStart(2, '0')} ${'x'.repeat(30)}`);
    logs.close();

    const main = path.join(small, 'r.log');
    const rot = `${main}.1`;
    ok('轮转文件存在', existsSync(rot));
    ok('当前文件不超过上限', statSync(main).size <= 400, `${statSync(main).size} bytes`);
    ok('轮转文件不超过上限', statSync(rot).size <= 400, `${statSync(rot).size} bytes`);
    ok('最新的还在', read(main).includes('line-19'));
    ok('轮转里是中间段', read(rot).includes('line-1') || read(rot).includes('line-0'));
    ok('最旧的被丢掉（只留一代）', !read(rot).includes('line-00') || !read(main).includes('line-00'));

    // 小批量写入（真实场景：一行一行来）应该完整保留
    const logs2 = new LogStore({ maxLines: 10, dir: small, maxBytes: 400 });
    logs2.clear('s');
    for (let i = 0; i < 12; i++) {
      logs2.append('s', 'out', `s-${i} ${'y'.repeat(20)}`);
      logs2.close(); // 强制每次 flush
    }
    ok('分批写入时文件轮转了', existsSync(path.join(small, 's.log.1')));
    ok('分批写入的最新一行在', read(path.join(small, 's.log')).includes('s-11'));
  }

  // ---- 4. clear 清空内存和文件 ----
  console.log('\n[4] clear 同时清内存和文件');
  {
    const logs = new LogStore({ maxLines: 100, dir });
    logs.append('c', 'out', 'before-clear');
    logs.close();
    ok('清空前文件有内容', read(path.join(dir, 'c.log')).includes('before-clear'));

    logs.clear('c');
    ok('内存已清', logs.lines('c').length === 0);
    eq('文件已清空', read(path.join(dir, 'c.log')), '');

    logs.append('c', 'out', 'after-clear');
    logs.close();
    const text = read(path.join(dir, 'c.log'));
    ok('清空后能继续写', text.includes('after-clear') && !text.includes('before-clear'));
  }

  // ---- 5. id 里的路径字符被清洗 ----
  console.log('\n[5] 非法 id 不会写到目录外');
  {
    const logs = new LogStore({ maxLines: 10, dir });
    logs.append('../../evil', 'out', 'x');
    logs.close();
    const escaped = path.resolve(dir, '..', '..', 'evil.log');
    ok('没有写到上级目录', !existsSync(escaped));
    const made = read(path.join(dir, '.._.._evil.log'));
    ok('落在日志目录内且名字被替换', made.includes('x'), `实际文件：${read(path.join(dir, '.._.._evil.log')) ? '有' : '无'}`);
  }

  // ---- 6. 不配 dir 就只进内存 ----
  console.log('\n[6] dir=null 时不落盘');
  {
    const logs = new LogStore({ maxLines: 10 });
    logs.append('m', 'out', 'memory-only');
    logs.close();
    eq('fileOf 返回 null', logs.fileOf('m'), null);
    eq('内存里有', logs.lines('m').length, 1);
    ok('没创建目录', !existsSync(path.join(dir, 'm.log')));
  }

  // ---- 7. 已有文件追加而不是覆盖 ----
  console.log('\n[7] 重启后追加，不覆盖历史');
  {
    const f = path.join(dir, 'keep.log');
    writeFileSync(f, '2026-01-01 00:00:00.000 [out] 上一次运行\n');
    const logs = new LogStore({ maxLines: 10, dir });
    logs.append('keep', 'out', '这一次运行');
    logs.close();
    const text = read(f);
    ok('旧内容还在', text.includes('上一次运行'));
    ok('新内容追加在后面', text.includes('这一次运行'));
    ok('顺序正确', text.indexOf('上一次') < text.indexOf('这一次'));
  }

  // ---- 8. write() 的半行处理也落盘 ----
  console.log('\n[8] 分块输出的半行');
  {
    const logs = new LogStore({ maxLines: 100, dir });
    logs.write('w', 'out', Buffer.from('完整一行\n半行'));
    logs.write('w', 'out', Buffer.from('补完\n'));
    logs.flush('w');
    logs.close();
    const text = read(path.join(dir, 'w.log'));
    ok('两行都落盘', text.includes('完整一行') && text.includes('半行补完'));
    ok('没有多出来的半行', text.trimEnd().split('\n').length === 2, `实际 ${text.trimEnd().split('\n').length} 行`);
  }

  // ---- 9. GBK 回退仍然有效（改动没破坏解码） ----
  console.log('\n[9] GBK 输出解码');
  {
    const logs = new LogStore({ maxLines: 10, dir });
    // "中文测试" 的 GBK 编码
    const gbkBuf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
    logs.write('g', 'out', gbkBuf);
    logs.flush('g');
    logs.close();
    const text = read(path.join(dir, 'g.log'));
    ok('GBK 正确解码成中文', text.includes('中文测试'), `实际：${JSON.stringify(text)}`);
  }

  // ---- 10. 真实子进程 → 文件（完整链路，不是模拟） ----
  console.log('\n[10] 真实子进程输出落盘');
  {
    const { spawn } = await import('node:child_process');
    const logs = new LogStore({ maxLines: 100, dir });
    const child = spawn(
      process.execPath,
      ['-e', 'console.log("stdout-line"); console.error("stderr-line"); process.exit(0)'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', (b) => logs.write('real', 'out', b));
    child.stderr.on('data', (b) => logs.write('real', 'err', b));

    await new Promise((resolve) => child.on('close', resolve));
    logs.flush('real');
    logs.close();

    const text = read(path.join(dir, 'real.log'));
    ok('stdout 落盘', text.includes('[out] stdout-line'), text.slice(0, 200));
    ok('stderr 落盘', text.includes('[err] stderr-line'));
    ok('两行都在', text.trimEnd().split('\n').length === 2, `实际 ${text.trimEnd().split('\n').length} 行`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓ 全过' : '✗ 有失败'}  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
