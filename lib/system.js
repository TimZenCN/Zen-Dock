// lib/system.js —— 跟操作系统打交道的脏活：开浏览器窗口、开资源管理器、读写开机自启
//
// 为什么不从前端直接 window.open：那样开出来的是标签页，而且 WebView2 里
// window.open 的行为跟普通浏览器不一致。走服务端 spawn 才能真正控制窗口形态。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

// 按优先级找 Chromium 系浏览器。只用它们，因为 --new-window / --app 是 Chromium 的私有参数。
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

export function findBrowser() {
  return BROWSERS.find((p) => existsSync(p)) || null;
}

/**
 * 在独立浏览器窗口里打开 url。
 * mode: 'window' → 带地址栏的新窗口（--new-window）
 *       'app'    → 无地址栏的独立窗口（--app=）
 */
export function openInBrowser(url, mode = 'window') {
  const browser = findBrowser();

  if (!browser) {
    // 没有 Chromium 系浏览器就退回系统默认，代价是只能开成标签页
    if (isWin) {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return { fallback: true, mode: 'tab' };
  }

  const args =
    mode === 'app'
      ? [`--app=${url}`, '--window-size=1280,860']
      : ['--new-window', url];

  spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { fallback: false, browser: path.basename(browser), mode };
}

/** 在资源管理器里定位。文件就选中它，目录就直接打开。 */
export async function revealPath(target) {
  if (!target) throw new Error('这一项没有可打开的路径');

  if (!isWin) {
    const dir = existsSync(target) && statSync(target).isDirectory() ? target : path.dirname(target);
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    await execFileAsync(cmd, [dir]).catch(() => {});
    return { opened: dir };
  }

  const exists = existsSync(target);
  const isFile = exists && statSync(target).isFile();
  // explorer 用 /select,<path> 定位并选中文件；打开目录直接传路径。
  // 它成功时也常返回 1，所以不能拿退出码判断成败。
  const arg = isFile ? `/select,${path.resolve(target)}` : path.resolve(target);
  await execFileAsync('explorer.exe', [arg]).catch(() => {});
  return { opened: path.resolve(target), selected: isFile };
}

// ---------- 开机自启（HKCU 的 Run 键，不需要管理员权限） ----------

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'Zen-Dock';

export function autoStartCommand() {
  const pythonw = path.join(ROOT, '.venv', 'Scripts', 'pythonw.exe');
  const script = path.join(ROOT, 'shell', 'desktop.py');
  if (!existsSync(pythonw)) return null;
  return `"${pythonw}" "${script}"`;
}

export async function getAutoStart() {
  if (!isWin) return { supported: false, enabled: false, command: null };
  const command = autoStartCommand();
  try {
    const { stdout } = await execFileAsync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], {
      windowsHide: true,
    });
    const match = stdout.match(/REG_SZ\s+(.+)/);
    return {
      supported: true,
      enabled: /Zen-Dock/.test(stdout),
      command: match ? match[1].trim() : null,
      ready: !!command,
    };
  } catch {
    // 值不存在时 reg 返回非 0，属于正常情况
    return { supported: true, enabled: false, command: null, ready: !!command };
  }
}

export async function setAutoStart(enabled) {
  if (!isWin) throw new Error('开机自启只支持 Windows');

  if (enabled) {
    const command = autoStartCommand();
    if (!command) {
      throw new Error('还没建 .venv，先跑 shell/setup.bat，否则注册了也起不来');
    }
    await execFileAsync(
      'reg',
      ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
      { windowsHide: true }
    );
  } else {
    await execFileAsync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], {
      windowsHide: true,
    }).catch(() => {});
  }
  return getAutoStart();
}
