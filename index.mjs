#!/usr/bin/env node
// Zen-Dock —— 本地服务面板
// 零依赖，node index.mjs 直接跑。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig, CONFIG_PATH, ROOT } from './lib/config.js';
import { LogStore } from './lib/logs.js';
import { ServiceManager } from './lib/services.js';
import { ScriptRunner } from './lib/scripts.js';
import { createHub } from './lib/server.js';

const VERSION = '0.1.0';

function parseArgv(argv) {
  const out = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const args = parseArgv(process.argv.slice(2));
if (args.help) {
  console.log(`Zen-Dock ${VERSION}

用法:
  node index.mjs [--port 7717] [--host 127.0.0.1] [--no-open]

配置文件: ${CONFIG_PATH}`);
  process.exit(0);
}

let config;
try {
  config = await loadConfig();
} catch (e) {
  console.error(`\n[致命] ${e.message}\n`);
  process.exit(1);
}
if (args.port) config.port = args.port;
if (args.host) config.host = args.host;

// 日志同时进内存（给 SSE 回放）和落盘（hub 重启后还能翻）。
// 落盘目录固定 logs/，和 shell/*.log（外壳自己的日志）分开。
const logs = new LogStore({
  maxLines: config.logLines,
  dir: path.join(ROOT, 'logs'),
});
const services = new ServiceManager({ config, logs });
const scripts = new ScriptRunner({ config, logs });

await services.init();

const hub = createHub({ config, services, scripts, logs });

let addr;
try {
  addr = await hub.listen(config.port, config.host);
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[致命] 端口 ${config.port} 已被占用。换个端口：node index.mjs --port 7718\n`);
  } else {
    console.error(`\n[致命] 监听失败：${e.message}\n`);
  }
  process.exit(1);
}

const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${addr.port}/`;
const counts = config.items.reduce((acc, it) => ((acc[it.kind] = (acc[it.kind] || 0) + 1), acc), {});

console.log(`
  Zen-Dock ${VERSION}
  ─────────────────────────────────
  面板    ${url}
  配置    ${CONFIG_PATH}
  项目    ${config.items.length} 项  (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ') || '空'})
  日志    ${config.logLines} 行/项
  ─────────────────────────────────
  Ctrl+C 退出（不会杀掉已在运行的服务）
`);

if (args.open) openBrowser(url);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] 正在退出…`);
  await services.shutdown();
  await hub.close();
  logs.close(); // 把攒着没刷的日志写盘
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 被 taskkill /F 时 SIGINT 收不到，但正常退出会走这里
process.on('exit', () => logs.close());
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e);
});
