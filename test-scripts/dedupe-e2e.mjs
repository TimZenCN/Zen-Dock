// 服务去重端到端验证：node test-scripts/dedupe-e2e.mjs
//
// 场景：进程已经在跑，但 Zen-Dock 的 runtime 状态里没有它（手工启动过、
// 状态文件被清掉、或者上次崩溃没来得及记录）。点「启动」时应该接管这个
// 进程，而不是再起一个同命令的第二个。
//
// 会临时改写 hub.state.json，结束时还原。

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceManager } from '../lib/services.js';
import { LogStore } from '../lib/logs.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, 'hub.state.json');
const CODE = 'setTimeout(()=>{},300000)'; // 跑五分钟的哑进程，命令行唯一

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  got=${got} want=${want}`}`);
}

const backup = await readFile(STATE, 'utf8').catch(() => null);

// 1. 手工起一个"已经在跑"的同命令进程，模拟状态丢失的残留实例
const manual = spawn(process.execPath, ['-e', CODE], { stdio: 'ignore', windowsHide: true });
await sleep(900);
console.log(`手工进程 pid=${manual.pid}`);

const logs = new LogStore({ maxLines: 200 });
const mgr = new ServiceManager({ config: { items: [], startTimeoutMs: 8000 }, logs });

const base = { kind: 'service', name: 'dup', cmd: 'node', args: ['-e', CODE] };

// 2. 默认去重：应该接管，不 spawn
const st = await mgr.start({ ...base, id: 'dup-test' });
console.log(`接管结果 status=${st.status} pid=${st.pid} external=${st.external}`);
check('状态为 running', st.status, 'running');
check('接管的是已有进程', st.pid, manual.pid);
check('标记为外部进程', st.external, true);
check('没有 spawn 新进程', mgr.children.size, 0);
check('日志说明是接管', logs.lines('dup-test').some((e) => e.text.includes('直接接管')), true);

// 3. dedupe:false 时应该真的再起一个（保留逃生口）
const st2 = await mgr.start({ ...base, id: 'dup-test2', dedupe: false });
console.log(`关掉去重 status=${st2.status} pid=${st2.pid}`);
check('关掉去重后真的新起了进程', st2.pid !== manual.pid, true);
check('确实 spawn 了一个', mgr.children.size, 1);

// 4. 清理
await mgr.stop('dup-test2');
await mgr.stop('dup-test');
manual.kill();
await sleep(300);

if (backup === null) {
  await writeFile(STATE, '{}\n', 'utf8');
} else {
  await writeFile(STATE, backup, 'utf8');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
