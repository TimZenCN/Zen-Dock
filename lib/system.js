// lib/system.js —— 跟操作系统打交道的脏活：开浏览器窗口、开资源管理器、读写开机自启
//
// 为什么不从前端直接 window.open：那样开出来的是标签页，而且 WebView2 里
// window.open 的行为跟普通浏览器不一致。走服务端 spawn 才能真正控制窗口形态。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

// 只用 Chromium 系浏览器，因为 --new-window / --app 是 Chromium 的私有参数。

// Chrome 的用户级安装目录跟用户名走，不能写死。LOCALAPPDATA 缺失时退回 home 推导。
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
// Chrome 排第一位：默认就用它，找不到才退到别的。
const BROWSER_CANDIDATES = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    paths: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${LOCAL_APPDATA}/Google/Chrome/Application/chrome.exe`,
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    paths: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
  },
  {
    id: 'brave',
    name: 'Brave',
    paths: ['C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'],
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    paths: ['C:/Program Files/Vivaldi/Application/vivaldi.exe'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    paths: ['C:/Program Files/Chromium/Application/chrome.exe'],
  },
];

/** 扫描本机装了哪些 Chromium 系浏览器，按优先级返回 */
export function listBrowsers() {
  const found = [];
  for (const b of BROWSER_CANDIDATES) {
    const hit = b.paths.find((p) => existsSync(p));
    if (hit) found.push({ id: b.id, name: b.name, path: hit });
  }
  return found;
}

export function findBrowser(preferred = '') {
  if (preferred && existsSync(preferred)) return preferred;
  const list = listBrowsers();
  return list.length ? list[0].path : null;
}

/**
 * 在独立浏览器窗口里打开 url。
 * mode: 'window' → 带地址栏的新窗口（--new-window）
 *       'app'    → 无地址栏的独立窗口（--app=）
 */
export function openInBrowser(url, mode = 'window', preferred = '') {
  const browser = findBrowser(preferred);

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
  return { fallback: false, browser: path.basename(browser), path: browser, mode };
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
  // --hidden：开机时不弹主窗口，直接进托盘，靠热键或托盘图标唤出
  return `"${pythonw}" "${script}" --hidden`;
}

/** 启动文件夹里的降级文件路径。注册表写不进去时用这个。 */
export function startupVbsPath() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  return path.join(
    appdata,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Zen-Dock.vbs'
  );
}

function writeStartupVbs() {
  const cmd = autoStartCommand();
  if (!cmd) throw new Error('还没建 .venv，先跑 shell/setup.bat');
  const target = startupVbsPath();
  if (!target) throw new Error('读不到 APPDATA，没法写启动文件夹');
  // 脚本语言里用 "" 表示一个引号；用 wscript 跑不闪窗口
  const body =
    'Set s = CreateObject("WScript.Shell")\r\n' +
    's.Run "' + cmd.replace(/"/g, '""') + '", 0, False\r\n';
  writeFileSync(target, body, 'utf8');
  return target;
}

function removeStartupVbs() {
  const target = startupVbsPath();
  if (target && existsSync(target)) {
    try {
      unlinkSync(target);
    } catch {
      // 删不掉就算了，下次还会再试
    }
  }
}

export async function getAutoStart() {
  if (!isWin) return { supported: false, enabled: false, command: null, stale: false };

  const expected = autoStartCommand();
  const vbs = startupVbsPath();
  const hasVbs = !!(vbs && existsSync(vbs));

  let regEnabled = false;
  let regCommand = null;
  let regError = null;
  try {
    const { stdout } = await execFileAsync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], {
      windowsHide: true,
    });
    regEnabled = /Zen-Dock/.test(stdout);
    const m = stdout.match(/REG_SZ\s+(.+)/);
    regCommand = m ? m[1].trim() : null;
  } catch (e) {
    // 退出码非 0 = 值不存在，正常。e.code 是字符串才说明 reg 根本没跑起来
    // （被沙箱、杀软或组策略拦了），这时候"未启用"的结论不可信。
    if (typeof e.code === 'string') regError = e.code;
  }

  const method = regEnabled ? 'registry' : hasVbs ? 'startup' : null;
  const current = regEnabled ? regCommand : hasVbs ? expected : null;

  return {
    supported: true,
    enabled: !!method,
    method,
    command: current,
    ready: !!expected,
    // 命令跟当前版本该注册的不一样（比如后来加了 --hidden），需要重新注册
    stale: !!(current && expected && current !== expected),
    expected,
    regError,
    vbsPath: vbs,
  };
}

export async function setAutoStart(enabled) {
  if (!isWin) throw new Error('开机自启只支持 Windows');

  if (enabled) {
    const command = autoStartCommand();
    if (!command) {
      throw new Error('还没建 .venv，先跑 shell/setup.bat，否则注册了也起不来');
    }
    try {
      await execFileAsync(
        'reg',
        ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
        { windowsHide: true }
      );
      removeStartupVbs(); // 注册表成了就把降级文件清掉，别两边都留着
    } catch (e) {
      // 注册表写不进去（沙箱、杀软、组策略都可能），退到启动文件夹。
      // 启动文件夹是纯文件操作，不走任何外部程序，基本不会被拦。
      const target = writeStartupVbs();
      const st = await getAutoStart();
      const why = typeof e.code === 'string' ? e.code : 'exit ' + e.code;
      return { ...st, note: `注册表写不进去（${why}），已改用启动文件夹：${target}` };
    }
  } else {
    // spawn 阶段的失败（EPERM/ENOENT）是同步抛的，promise 的 .catch 接不住，
    // 必须用 try/catch 包住。
    try {
      await execFileAsync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], {
        windowsHide: true,
      });
    } catch {
      // 删不掉无所谓：reg 被拦，或者这个值本来就不存在
    }
    removeStartupVbs();
  }
  return getAutoStart();
}

// ---------- 关于信息 ----------

/** 读 package.json 的版本号，读不到就返回 null（不抛）。 */
function pkgVersion(relPath) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** package.json 全文。作者、仓库、协议这些元数据都从这儿读，不在代码里写死。 */
function pkgMeta() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 从 repository 字段里抠出 { owner, repo }。支持 git+https、https、git@ 三种写法。 */
function repoSlug() {
  const pkg = pkgMeta();
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

/** 仓库的网页地址。没有 repository 字段就返回 null。 */
function repoHtmlUrl() {
  const slug = repoSlug();
  return slug ? `https://github.com/${slug.owner}/${slug.repo}` : null;
}

/** 按 . 分段比较版本号，返回 -1 / 0 / 1。够用，不引 semver。 */
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 扫 WebView2 运行时目录，取版本号最大的那个。 */
function detectWebView2() {
  const bases = [
    'C:/Program Files (x86)/Microsoft/EdgeWebView/Application',
    'C:/Program Files/Microsoft/EdgeWebView/Application',
  ];
  for (const base of bases) {
    try {
      const dirs = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\.\d+/.test(d.name))
        .map((d) => d.name);
      if (!dirs.length) continue;
      dirs.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0);
          if (d) return d;
        }
        return 0;
      });
      return dirs[dirs.length - 1];
    } catch {
      // 目录不存在，试下一个
    }
  }
  return null;
}

/** 从 .venv 里的 dist-info 目录名反推 pywebview 版本。 */
function detectPywebview() {
  try {
    const dir = path.join(ROOT, '.venv', 'Lib', 'site-packages');
    const hit = readdirSync(dir).find((n) => /^pywebview-.*\.dist-info$/.test(n));
    return hit ? hit.replace(/^pywebview-/, '').replace(/\.dist-info$/, '') : null;
  } catch {
    return null;
  }
}

export function aboutInfo() {
  const venv = path.join(ROOT, '.venv', 'Scripts', 'pythonw.exe');
  const pkg = pkgMeta();
  return {
    version: pkg.version || pkgVersion('package.json'),
    description: pkg.description || '',
    author: pkg.author?.name || '',
    authorUrl: pkg.author?.url || '',
    repoUrl: repoHtmlUrl(),
    license: pkg.license || '',
    node: process.version,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    host: `${os.hostname()}`,
    rootPath: ROOT,
    configPath: path.join(ROOT, 'hub.config.json'),
    logDir: path.join(ROOT, 'shell'),
    webview2: detectWebView2(),
    pywebview: detectPywebview(),
    shellReady: existsSync(venv),
  };
}

// ---- 版本检查 ----

const UPDATE_CACHE_MS = 10 * 60 * 1000;
let updateCache = { at: 0, data: null };

/**
 * 查 GitHub 最新 Release，和 package.json 的 version 比。
 *
 * 失败一律返回 `ok:false` + `reason`，不抛异常 —— 关于页要能优雅降级成
 * 「检查失败，点这里手动看」，而不是弹一个红字报错。
 * 结果缓存 10 分钟：未认证的 GitHub API 只有 60 次/小时，反复点按钮会把
 * 配额打光，之后连正常检查都会失败。
 */
export async function checkUpdate(force = false) {
  const current = pkgVersion('package.json');
  const slug = repoSlug();
  if (!slug) {
    return { ok: false, current, reason: 'no-repo', message: 'package.json 里没有 GitHub 仓库地址' };
  }

  const now = Date.now();
  if (!force && updateCache.data && now - updateCache.at < UPDATE_CACHE_MS) {
    return { ...updateCache.data, cached: true };
  }

  const api = `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases/latest`;
  let data;
  try {
    const res = await fetch(api, {
      headers: { 'User-Agent': 'zen-dock-update-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404) {
      data = { ok: false, current, reason: 'no-release', message: '仓库里还没有 Release' };
    } else if (res.status === 403 || res.status === 429) {
      data = { ok: false, current, reason: 'rate-limit', message: 'GitHub 接口限流，过一会儿再试' };
    } else if (!res.ok) {
      data = { ok: false, current, reason: `http-${res.status}`, message: `GitHub 返回 ${res.status}` };
    } else {
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      data = {
        ok: true,
        current,
        latest,
        hasUpdate: cmpVersion(latest, current) > 0,
        name: rel.name || '',
        notes: String(rel.body || '').slice(0, 1500),
        publishedAt: rel.published_at || '',
        releaseUrl: rel.html_url || '',
        repoUrl: repoHtmlUrl(),
      };
    }
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    data = {
      ok: false,
      current,
      reason: 'network',
      message: timeout ? '连 GitHub 超时' : `连不上 GitHub（${e?.message || e}）`,
    };
  }

  updateCache = { at: now, data };
  return data;
}

// ---- 打开外部链接 ----
//
// 前端只能传 kind，真实地址由服务端从 package.json 拼出来。
// 这样这个端点就不可能被拿去开任意 URL —— 它连参数都传不进来。

const EXTERNAL_KINDS = {
  author: () => pkgMeta().author?.url || '',
  repo: () => repoHtmlUrl() || '',
  releases: () => (repoHtmlUrl() ? `${repoHtmlUrl()}/releases` : ''),
  license: () => (repoHtmlUrl() ? `${repoHtmlUrl()}/blob/main/LICENSE` : ''),
};

export function openExternal(kind, browser = '') {
  const fn = EXTERNAL_KINDS[kind];
  if (!fn) throw new Error(`未知的外部链接：${kind}`);
  const url = fn();
  if (!url) throw new Error('这个链接还没配置（package.json 缺 author 或 repository）');
  if (!/^https:\/\/(www\.)?github\.com\//i.test(url)) {
    throw new Error('只允许打开 GitHub 链接');
  }
  return { ...openInBrowser(url, 'window', browser), url };
}
