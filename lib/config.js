// lib/config.js —— 配置读写与校验
// 唯一真相是 hub.config.json（人可读可手改）；本模块只负责读、校验、原子写回。

import { readFile, writeFile, rename, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = path.join(ROOT, 'hub.config.json');
export const EXAMPLE_PATH = path.join(ROOT, 'hub.config.example.json');
export const STATE_PATH = path.join(ROOT, 'hub.state.json');

// 配置里的 ./ 或 ../ 开头路径按项目根解析，这样配置可以跨机器复用。
// 绝对路径原样返回。配置文件本身永远存用户写的原样，解析只发生在运行时。
export function resolveLocal(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('./') || p.startsWith('../')) return path.resolve(ROOT, p);
  return p;
}

export const KINDS = ['service', 'script', 'page'];
export const SHELLS = ['powershell', 'python', 'bat'];
const ID_RE = /^[a-zA-Z0-9_-]+$/;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7717,
  logLines: 500,
  startTimeoutMs: 15000,
  items: [],
};

// 全局设置。openMode / closeAction / browser / hotkey 只有桌面外壳会用到，
// 但存在配置里才能让「设置页改完立刻生效」——外壳每次读文件，不做常驻缓存。
export const DEFAULT_SETTINGS = {
  openMode: 'window', // window | app
  closeAction: 'quit', // quit | tray
  autoStart: false,
  browser: '', // 空 = 自动，优先 Chrome
  hotkey: 'alt+x', // 唤出拓展坞的全局热键
  dockMode: 'ring', // ring | panel
  dockItems: null, // null = 没配过，自动填前 DOCK_MAX 个；[] = 用户显式清空
};

const OPEN_MODES = ['window', 'app'];
const CLOSE_ACTIONS = ['quit', 'tray'];
const DOCK_MODES = ['ring', 'panel'];

// 圆环固定 8 个方位，12 点留给主页按钮，所以快捷项最多 7 个。
export const DOCK_MAX = 7;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

export function validateItem(item, seenIds = new Set()) {
  const errs = [];
  const where = item?.id ? `item "${item.id}"` : 'item';

  if (!item || typeof item !== 'object') return ['item 必须是对象'];
  if (!item.id || !ID_RE.test(item.id)) errs.push(`${where}: id 必填，且只允许字母数字下划线连字符`);
  else if (seenIds.has(item.id)) errs.push(`${where}: id 重复`);
  if (!KINDS.includes(item.kind)) errs.push(`${where}: kind 必须是 ${KINDS.join(' / ')}`);
  if (!item.name || typeof item.name !== 'string') errs.push(`${where}: name 必填`);
  if (item.shortName !== undefined && typeof item.shortName !== 'string') {
    errs.push(`${where}: shortName 必须是字符串`);
  }

  if (item.kind === 'service') {
    if (!item.cmd) errs.push(`${where}: service 必须指定 cmd`);
    if (item.port != null && !Number.isInteger(item.port)) errs.push(`${where}: port 必须是整数`);
    // urlFrom 是从输出里抓真实地址的正则，第一个捕获组就是 URL
    if (item.urlFrom !== undefined) {
      if (typeof item.urlFrom !== 'string' || !item.urlFrom) {
        errs.push(`${where}: urlFrom 必须是非空字符串`);
      } else {
        try {
          new RegExp(item.urlFrom);
        } catch (e) {
          errs.push(`${where}: urlFrom 不是合法正则（${e.message}）`);
        }
      }
    }
  }
  if (item.kind === 'script') {
    if (!SHELLS.includes(item.shell)) errs.push(`${where}: shell 必须是 ${SHELLS.join(' / ')}`);
    if (!item.path) errs.push(`${where}: script 必须指定 path`);
  }
  if (item.kind === 'page') {
    if (!item.dir) errs.push(`${where}: page 必须指定 dir`);
  }
  return errs;
}

export function validateConfig(cfg) {
  const errs = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) errs.push('port 非法');
  if (typeof cfg.host !== 'string' || !cfg.host) errs.push('host 非法');
  if (!Number.isInteger(cfg.logLines) || cfg.logLines < 50) errs.push('logLines 至少 50');
  if (cfg.settings) {
    if (cfg.settings.openMode && !OPEN_MODES.includes(cfg.settings.openMode)) {
      errs.push(`settings.openMode 必须是 ${OPEN_MODES.join(' / ')}`);
    }
    if (cfg.settings.closeAction && !CLOSE_ACTIONS.includes(cfg.settings.closeAction)) {
      errs.push(`settings.closeAction 必须是 ${CLOSE_ACTIONS.join(' / ')}`);
    }
    if (cfg.settings.dockMode && !DOCK_MODES.includes(cfg.settings.dockMode)) {
      errs.push(`settings.dockMode 必须是 ${DOCK_MODES.join(' / ')}`);
    }
    if (cfg.settings.dockItems != null) {
      if (!Array.isArray(cfg.settings.dockItems)) {
        errs.push('settings.dockItems 必须是数组');
      } else if (cfg.settings.dockItems.length > DOCK_MAX) {
        errs.push(`settings.dockItems 最多 ${DOCK_MAX} 个`);
      }
    }
  }
  if (!Array.isArray(cfg.items)) errs.push('items 必须是数组');
  else {
    const seen = new Set();
    for (const it of cfg.items) {
      errs.push(...validateItem(it, seen));
      if (it?.id) seen.add(it.id);
    }
  }
  return errs;
}

export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  cfg.items = Array.isArray(cfg.items) ? cfg.items : [];
  cfg.items = cfg.items.map((it) => ({
    ...it,
    enabled: it.enabled !== false,
  }));

  // dockItems 用 null 当哨兵：没配过就默认填前 7 个可用项，
  // 显式配成 [] 就尊重用户"一个都不要进坞"的选择，不再自动填。
  const ids = new Set(cfg.items.map((i) => i.id));
  if (cfg.settings.dockItems == null) {
    cfg.settings.dockItems = cfg.items
      .filter((i) => i.enabled)
      .slice(0, DOCK_MAX)
      .map((i) => i.id);
  } else {
    cfg.settings.dockItems = [...new Set(cfg.settings.dockItems)]
      .filter((id) => ids.has(id))
      .slice(0, DOCK_MAX);
  }
  return cfg;
}

/** 圆环里显示的名字：优先 shortName，否则按显示宽度截断 name。 */
export function dockLabel(item) {
  const raw = (item.shortName || item.name || item.id || '').trim();
  // 圆环扇区在 11px 字号下大约放得下 6 个汉字宽
  let width = 0;
  let out = '';
  for (const ch of raw) {
    const w = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (width + w > 12) return out + '…';
    width += w;
    out += ch;
  }
  return out;
}

export async function loadConfig() {
  if (!(await exists(CONFIG_PATH))) {
    if (await exists(EXAMPLE_PATH)) {
      await copyFile(EXAMPLE_PATH, CONFIG_PATH);
      console.log('[config] 没有 hub.config.json，已从 hub.config.example.json 复制一份');
    } else {
      const fresh = normalizeConfig({});
      await saveConfig(fresh);
      return fresh;
    }
  }
  const text = await readFile(CONFIG_PATH, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`hub.config.json 不是合法 JSON：${e.message}`);
  }
  const cfg = normalizeConfig(raw);
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`hub.config.json 校验失败：\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

// 原子写：先写临时文件再 rename，避免写一半崩掉留下坏配置
export async function saveConfig(cfg) {
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`拒绝写入非法配置：\n  - ${errs.join('\n  - ')}`);
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  await rename(tmp, CONFIG_PATH);
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, STATE_PATH);
}

export function findItem(cfg, id) {
  return cfg.items.find((it) => it.id === id) || null;
}

// 增改：有同 id 则整条替换（保留未提供的字段），否则追加
export function upsertItem(cfg, patch) {
  const idx = cfg.items.findIndex((it) => it.id === patch.id);
  if (idx >= 0) {
    cfg.items[idx] = { ...cfg.items[idx], ...patch };
  } else {
    cfg.items.push(patch);
  }
  return cfg;
}

export function removeItem(cfg, id) {
  const before = cfg.items.length;
  cfg.items = cfg.items.filter((it) => it.id !== id);
  return cfg.items.length !== before;
}
