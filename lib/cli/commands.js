// lib/cli/commands.js —— 各子命令的实现
//
// 一条规则贯穿全文件：能查文件的事不要求 hub 在线，需要动进程的事必须在线。
// 因为进程状态只活在 hub 的内存里，CLI 自己去 spawn 只会让两边状态打架。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  ROOT,
  loadConfig,
  saveConfig,
  findItem,
  upsertItem,
  removeItem,
  validateItem,
  KINDS,
  SHELLS,
} from '../config.js';
import {
  table,
  color,
  statusText,
  kindText,
  humanDuration,
  formatLogLine,
  indent,
} from './format.js';

// ---------- 小工具 ----------

function out(ctx, text) {
  if (!ctx.json) process.stdout.write(text + '\n');
}

function emitJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// 按 shell 习惯拆参数：引号内不拆，支持 "a b" 和 'a b'
function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(s)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

// 在线优先从 hub 拿（带 runtime），离线退回配置文件
async function resolveItem(ctx, id) {
  if (await ctx.client.probe()) {
    try {
      return await ctx.client.item(id);
    } catch {
      return null;
    }
  }
  const cfg = await loadConfig();
  return findItem(cfg, id);
}

async function writeItem(ctx, item) {
  if (await ctx.client.probe()) {
    await ctx.client.upsertItem(item);
    return 'api';
  }
  const cfg = await loadConfig();
  upsertItem(cfg, item);
  await saveConfig(cfg);
  return 'file';
}

function offlineNote(ctx) {
  if (ctx.json) return;
  out(ctx, color.gray('hub 没在跑，只显示配置里的定义（启动/停止/日志需要 hub 在线，用 zd up）'));
}

function fail(err) {
  // hub 离线的错误往上抛，由入口统一补一句「zd up」，别在这里吞掉
  if (err && err.name === 'HubOfflineError') throw err;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(color.red(`zd: ${msg}`) + '\n');
  return 1;
}

// ---------- list ----------

export async function cmdList(ctx) {
  const online = await ctx.client.probe();
  let items = [];
  let hub = null;

  if (online) {
    const d = await ctx.client.state();
    items = d.items || [];
    hub = d.hub;
  } else {
    const cfg = await loadConfig();
    items = cfg.items.map((it) => ({ ...it, runtime: null }));
    hub = { port: cfg.port, host: cfg.host };
  }

  if (ctx.json) {
    emitJson({
      hub: { online, port: hub?.port, host: hub?.host },
      items,
    });
    return 0;
  }

  if (!items.length) {
    out(ctx, color.gray('还没有任何项。注册一个：zd add'));
    return 0;
  }

  const rows = items.map((it) => {
    const rt = it.runtime || {};
    const status = online ? statusText(rt.status) : color.gray('—');
    // runtimeOf 给的是 services.get() 的原始状态，不含 uptimeMs（只有 snapshot() 才加），自己算
    const uptime = rt.startedAt ? Date.now() - rt.startedAt : null;
    let extra = '';
    if (it.kind === 'service') {
      extra = it.port ? `:${it.port}` : '';
      if (rt.status === 'running' && uptime != null) extra += `  ${humanDuration(uptime)}`;
      else if (rt.exitCode != null) extra += `  exit ${rt.exitCode}`;
    } else if (it.kind === 'script') {
      extra = path.basename(it.path || '');
      if (rt.status === 'running') extra += '  运行中';
      else if (rt.exitCode != null) extra += `  exit ${rt.exitCode}`;
    } else {
      extra = `/s/${it.id}/`;
    }
    if (rt.external) extra += color.yellow('  外部');
    return [color.bold(it.id), kindText(it.kind), status, extra, it.name || ''];
  });

  out(
    ctx,
    table(
      [
        { title: 'ID' },
        { title: '类型' },
        { title: '状态' },
        { title: '端口 / 脚本' },
        { title: '名称' },
      ],
      rows
    )
  );

  if (!online) {
    out(ctx, '');
    offlineNote(ctx);
  } else {
    const running = items.filter((i) => i.runtime && i.runtime.status === 'running').length;
    out(ctx, '');
    out(
      ctx,
      color.gray(
        `${items.length} 项 · ${running} 个在跑 · hub 127.0.0.1:${hub.port}`
      )
    );
  }
  return 0;
}

// ---------- status ----------

export async function cmdStatus(ctx) {
  const port = await ctx.client.port();
  const online = await ctx.client.probe();

  if (ctx.json) {
    if (!online) {
      emitJson({ online: false, port });
      return 0;
    }
    const d = await ctx.client.state();
    const running = (d.items || []).filter((i) => i.runtime?.status === 'running');
    emitJson({
      online: true,
      port: d.hub.port,
      host: d.hub.host,
      items: (d.items || []).length,
      running: running.length,
      uptimeMs: d.hub.uptimeMs ?? null,
    });
    return 0;
  }

  if (!online) {
    out(ctx, `${color.gray('状态')}  ${color.red('未运行')}`);
    out(ctx, `${color.gray('端口')}  127.0.0.1:${port}`);
    out(ctx, '');
    out(ctx, color.gray('起一个：zd up'));
    return 0;
  }

  const d = await ctx.client.state();
  const items = d.items || [];
  const running = items.filter((i) => i.runtime?.status === 'running');
  out(ctx, `${color.gray('状态')}  ${color.green('运行中')}`);
  out(ctx, `${color.gray('地址')}  http://${d.hub.host}:${d.hub.port}/`);
  out(ctx, `${color.gray('项目')}  ${items.length} 项，${running.length} 个在跑`);
  if (running.length) {
    out(ctx, '');
    for (const it of running) {
      const rt = it.runtime;
      const up = rt.startedAt ? Date.now() - rt.startedAt : null;
      out(ctx, `  ${color.green('●')} ${it.id}  pid ${rt.pid ?? '?'}  ${humanDuration(up)}`);
    }
  }
  return 0;
}

// ---------- show ----------

export async function cmdShow(ctx, id) {
  if (!id) return fail('用法：zd show <id>');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);

  if (ctx.json) {
    emitJson(item);
    return 0;
  }

  const rt = item.runtime;
  out(ctx, `${color.bold(item.name)}  ${color.gray(`(${item.id})`)}`);
  out(ctx, '');
  out(ctx, `${color.gray('类型')}  ${kindText(item.kind)}`);
  if (item.kind === 'service') {
    out(ctx, `${color.gray('命令')}  ${item.cmd} ${(item.args || []).join(' ')}`);
    if (item.cwd) out(ctx, `${color.gray('目录')}  ${item.cwd}`);
    if (item.port) out(ctx, `${color.gray('端口')}  ${item.port}`);
    if (item.url) out(ctx, `${color.gray('地址')}  ${item.url}`);
  } else if (item.kind === 'script') {
    out(ctx, `${color.gray('Shell')} ${item.shell}`);
    out(ctx, `${color.gray('路径')}  ${item.path}`);
    if (item.cwd) out(ctx, `${color.gray('目录')}  ${item.cwd}`);
    const params = item.params || [];
    if (params.length) {
      out(ctx, `${color.gray('参数')}`);
      for (const p of params) {
        const def = p.default === undefined ? '' : ` = ${p.default}`;
        out(ctx, `  ${p.flag || p.name}${def}  ${color.gray(p.type || 'string')}`);
      }
    }
  } else {
    out(ctx, `${color.gray('目录')}  ${item.dir}`);
    out(ctx, `${color.gray('入口')}  ${item.entry || 'index.html'}`);
  }

  if (rt) {
    out(ctx, '');
    out(ctx, `${color.gray('状态')}  ${statusText(rt.status)}`);
    if (rt.pid) out(ctx, `${color.gray('PID')}   ${rt.pid}${rt.external ? color.yellow('  （外部启动）') : ''}`);
    const up = rt.startedAt ? Date.now() - rt.startedAt : null;
    if (up) out(ctx, `${color.gray('运行')}  ${humanDuration(up)}`);
    if (rt.exitCode != null) out(ctx, `${color.gray('退出码')} ${rt.exitCode}`);
  } else {
    out(ctx, '');
    offlineNote(ctx);
  }
  return 0;
}

// ---------- start / stop / restart ----------

export async function cmdStart(ctx, id) {
  if (!id) return fail('用法：zd start <id>');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);
  if (item.kind === 'script') return fail(`${id} 是脚本，用 zd run ${id}`);
  if (item.kind === 'page') return fail(`${id} 是静态页面，用 zd open ${id}`);

  const rt = item.runtime;
  if (rt && rt.status === 'running') {
    out(ctx, color.gray(`${id} 已经在跑了（pid ${rt.pid ?? '?'}）`));
    return 0;
  }

  // 进度提示只在真终端里画：重定向到文件时 \r 不会清行，会留下一串空格
  const spinner = !ctx.json && process.stdout.isTTY;
  if (spinner) process.stdout.write(color.gray(`启动 ${id}…`));
  let res;
  try {
    res = await ctx.client.start(id);
  } catch (e) {
    if (spinner) process.stdout.write('\r' + ' '.repeat(24) + '\r');
    return fail(e);
  }
  if (spinner) process.stdout.write('\r' + ' '.repeat(24) + '\r');

  const st = res.runtime || {};
  if (ctx.json) {
    emitJson(res);
    return st.status === 'running' ? 0 : 1;
  }
  if (st.status === 'running') {
    out(
      ctx,
      `${color.green('✓')} ${id} 已启动   pid ${st.pid ?? '?'}${item.port ? `   :${item.port}` : ''}`
    );
    return 0;
  }
  return fail(`${id} 启动后状态是 ${st.status}，看日志：zd logs ${id} -n 30`);
}

export async function cmdStop(ctx, id) {
  if (!id) return fail('用法：zd stop <id>');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);
  try {
    await ctx.client.stop(id);
  } catch (e) {
    return fail(e);
  }
  if (ctx.json) {
    emitJson({ ok: true, id });
    return 0;
  }
  out(ctx, `${color.green('✓')} ${id} 已停止`);
  return 0;
}

export async function cmdRestart(ctx, id) {
  if (!id) return fail('用法：zd restart <id>');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);
  if (item.runtime?.status === 'running') {
    try {
      await ctx.client.stop(id);
    } catch (e) {
      return fail(`停止失败：${e.message}`);
    }
    if (!ctx.json) out(ctx, color.gray('已停止，重新启动…'));
  }
  return cmdStart(ctx, id);
}

// ---------- run ----------

export async function cmdRun(ctx, id, flags) {
  if (!id) return fail('用法：zd run <id> [--参数 值 …]');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);
  if (item.kind !== 'script') return fail(`${id} 不是脚本`);

  const params = item.params || [];
  const values = {};
  const unknown = [];

  for (const [key, val] of Object.entries(flags)) {
    if (['json', 'color', 'port', 'follow', 'lines', 'force'].includes(key)) continue;
    const hit = params.find((p) => p.name === key || (p.flag || '').replace(/^-+/, '') === key);
    if (!hit) {
      unknown.push(key);
      continue;
    }
    values[hit.name] = hit.type === 'boolean' ? val !== 'false' : val;
  }

  if (unknown.length) {
    const available = params.map((p) => p.flag || `--${p.name}`).join(' ');
    return fail(
      `未知参数：${unknown.map((u) => '--' + u).join(' ')}` +
        (available ? `\n可用参数：${available}` : '\n这个脚本没有声明任何参数')
    );
  }

  let res;
  try {
    res = await ctx.client.run(id, values);
  } catch (e) {
    return fail(e);
  }

  if (ctx.json) {
    emitJson(res);
    return 0;
  }
  const st = res.runtime || {};
  out(ctx, `${color.green('✓')} ${id} 已启动   pid ${st.pid ?? '?'}`);
  out(ctx, color.gray(`Ctrl+C 会终止脚本；只想看输出用 zd logs ${id} -f`));
  return 0;
}

// ---------- logs ----------

export async function cmdLogs(ctx, id, opts = {}) {
  if (!id) return fail('用法：zd logs <id> [-f] [-n 50]');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);

  const limit = Number(opts.lines ?? 50);
  let history = [];
  try {
    history = await ctx.client.logs(id, 0);
  } catch (e) {
    return fail(e);
  }

  if (ctx.json && !opts.follow) {
    emitJson({ id, lines: history.slice(-limit) });
    return 0;
  }

  const shown = history.slice(-limit);
  let lastSeq = 0;
  for (const entry of shown) {
    process.stdout.write(formatLogLine(entry) + '\n');
    lastSeq = Math.max(lastSeq, entry.seq || 0);
  }

  if (!opts.follow) {
    if (!shown.length) out(ctx, color.gray('（还没有日志）'));
    return 0;
  }

  const ac = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    // 第二次 Ctrl+C 直接退：万一 abort 之后流没立刻结束，别让用户卡在终端里
    if (interrupted) {
      process.exit(130);
      return;
    }
    interrupted = true;
    ac.abort();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', onSigint);

  try {
    await ctx.client.followLogs(
      id,
      (entry) => {
        if ((entry.seq || 0) <= lastSeq) return; // 历史与订阅之间可能有重叠
        lastSeq = entry.seq || lastSeq;
        process.stdout.write(formatLogLine(entry) + '\n');
      },
      { signal: ac.signal }
    );
  } catch (e) {
    process.off('SIGINT', onSigint);
    if (!ac.signal.aborted) return fail(e);
  }
  process.off('SIGINT', onSigint);

  // 不能用 process.exit()：stdout 重定向到文件时是异步写，exit 会丢掉最后一行
  if (interrupted) {
    process.stdout.write('\n' + color.gray('已停止跟随（进程仍在运行）') + '\n');
  }
  return 0;
}

// ---------- open ----------

export async function cmdOpen(ctx, id) {
  if (!id) return fail('用法：zd open <id>');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);
  // runtime.url 是从输出里抓到的真实地址（可能带一次性 token），优先用它
  const rel = (item.runtime && item.runtime.url) || item.url || `/s/${id}/`;
  const base = await ctx.client.base(); // 不带尾斜杠
  const url = rel.startsWith('http') ? rel : `${base}/${rel.replace(/^\//, '')}`;

  try {
    const r = await ctx.client.openWindow(url);
    if (ctx.json) {
      emitJson({ ok: true, url, ...r });
      return 0;
    }
    out(ctx, `${color.green('✓')} 已打开 ${url}`);
    return 0;
  } catch (e) {
    return fail(e);
  }
}

// ---------- add ----------

const FIELD_HINTS = {
  service: [
    ['cmd', '启动命令（如 node / python / npm）', true],
    ['args', '参数，空格分隔（可留空）', false],
    ['cwd', '工作目录（可留空 = 项目根）', false],
    ['port', '监听端口（可留空 = 不做端口探活）', false],
    ['url', '打开页面时的地址（可留空）', false],
  ],
  script: [
    ['shell', `脚本类型 ${SHELLS.join(' / ')}`, true],
    ['path', '脚本路径', true],
    ['cwd', '工作目录（可留空）', false],
  ],
  page: [
    ['dir', '静态页面目录', true],
    ['entry', '入口文件（默认 index.html）', false],
  ],
};

function buildFromFlags(ctx, type, id, flags) {
  const item = { id, kind: type, name: flags.name || id, enabled: true };

  if (type === 'service') {
    if (!flags.cmd) return { error: 'service 必须指定 --cmd' };
    item.cmd = flags.cmd;
    item.args = flags.args ? splitArgs(flags.args) : [];
    if (flags.cwd) item.cwd = flags.cwd;
    if (flags.port != null) {
      const p = Number(flags.port);
      if (!Number.isInteger(p)) return { error: '--port 必须是整数' };
      item.port = p;
    }
    if (flags.url) item.url = flags.url;
    if (flags.urlFrom) item.urlFrom = flags.urlFrom;
    if (flags.startTimeoutMs != null) {
      const t = Number(flags.startTimeoutMs);
      if (!Number.isInteger(t) || t <= 0) return { error: '--startTimeoutMs 必须是正整数' };
      item.startTimeoutMs = t;
    }
  } else if (type === 'script') {
    const shell = flags.shell || 'powershell';
    if (!SHELLS.includes(shell)) return { error: `--shell 必须是 ${SHELLS.join(' / ')}` };
    if (!flags.path) return { error: 'script 必须指定 --path' };
    item.shell = shell;
    item.path = flags.path;
    if (flags.cwd) item.cwd = flags.cwd;
  } else {
    if (!flags.dir) return { error: 'page 必须指定 --dir' };
    item.dir = flags.dir;
    item.entry = flags.entry || 'index.html';
  }
  return { item };
}

async function addWizard(ctx) {
  // 先读配置再建 readline：中间那个 await 会让事件循环空转，
  // 管道输入（比如把答案 echo 进来）可能在这期间读完并触发 close，
  // 之后第一次 question 就抛 "readline was closed"。
  const cfg = await loadConfig();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let cancelled = false;
  rl.on('SIGINT', () => {
    cancelled = true;
    rl.close();
    process.stdout.write('\n' + color.gray('已取消，没有写入任何东西') + '\n');
    process.exit(130);
  });

  const ask = async (label, fallback = '') => {
    const hint = fallback ? color.gray(` [${fallback}]`) : '';
    const ans = (await rl.question(`${label}${hint}: `)).trim();
    return ans || fallback;
  };

  try {
    out(ctx, color.gray('注册新项（Ctrl+C 随时取消）'));
    out(ctx, '');

    let type = await ask(`类型 (${KINDS.join(' / ')})`, 'service');
    while (!KINDS.includes(type)) {
      out(ctx, color.red(`  只能是 ${KINDS.join(' / ')}`));
      type = await ask('类型', 'service');
    }

    let id = await ask('ID（字母数字下划线连字符）');
    while (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      out(ctx, color.red('  ID 必填，只允许字母数字下划线连字符'));
      id = await ask('ID');
    }
    if (findItem(cfg, id)) out(ctx, color.yellow(`  注意：${id} 已存在，将被覆盖`));

    const name = await ask('名称', id);
    const item = { id, kind: type, name, enabled: true };

    for (const [key, label, required] of FIELD_HINTS[type]) {
      const val = await ask(label + (required ? '' : ''));
      if (!val) {
        if (required) out(ctx, color.yellow('  这项建议填，先留空'));
        continue;
      }
      if (key === 'args') item.args = splitArgs(val);
      else if (key === 'port') item.port = Number(val);
      else item[key] = val;
    }

    if (type === 'service' && !item.cmd) {
      rl.close();
      return fail('service 必须有 cmd，已取消');
    }
    if (type === 'script' && !item.path) {
      rl.close();
      return fail('script 必须有 path，已取消');
    }
    if (type === 'page' && !item.dir) {
      rl.close();
      return fail('page 必须有 dir，已取消');
    }
    rl.close();
    if (cancelled) return 130;

    const errs = validateItem(item);
    if (errs.length) return fail(errs.join('；'));

    const via = await writeItem(ctx, item);
    out(ctx, '');
    out(ctx, `${color.green('✓')} 已注册 ${color.bold(id)}（写入${via === 'api' ? '运行中的 hub' : '配置文件'}）`);
    if (type === 'service') out(ctx, color.gray(`启动：zd start ${id}`));
    if (type === 'script') out(ctx, color.gray(`运行：zd run ${id}`));
    if (type === 'page') out(ctx, color.gray(`打开：zd open ${id}`));
    return 0;
  } catch (e) {
    rl.close();
    if (cancelled) return 130;
    return fail(e);
  }
}

export async function cmdAdd(ctx, positional, flags) {
  if (!positional.length) return addWizard(ctx);

  const type = positional[0];
  const id = positional[1];

  if (!KINDS.includes(type)) {
    return fail(`类型只能是 ${KINDS.join(' / ')}，例：zd add service relay --cmd node`);
  }
  if (!id) return fail(`用法：zd add ${type} <id> [选项]，选项见 zd help add`);

  const built = buildFromFlags(ctx, type, id, flags);
  if (built.error) return fail(built.error);

  const errs = validateItem(built.item);
  if (errs.length) return fail(errs.join('；'));

  let via;
  try {
    via = await writeItem(ctx, built.item);
  } catch (e) {
    return fail(e);
  }

  if (ctx.json) {
    emitJson({ ok: true, via, item: built.item });
    return 0;
  }
  out(ctx, `${color.green('✓')} 已注册 ${color.bold(id)}  ${kindText(type)}  ${built.item.name}`);
  if (type === 'service') out(ctx, color.gray(`启动：zd start ${id}`));
  if (type === 'script') out(ctx, color.gray(`运行：zd run ${id}`));
  if (type === 'page') out(ctx, color.gray(`打开：zd open ${id}`));
  return 0;
}

// ---------- edit ----------

const EDITABLE = {
  service: ['name', 'cmd', 'args', 'cwd', 'port', 'url', 'urlFrom', 'startTimeoutMs', 'enabled'],
  script: ['name', 'shell', 'path', 'cwd', 'enabled'],
  page: ['name', 'dir', 'entry', 'enabled'],
};

export async function cmdEdit(ctx, id, flags) {
  if (!id) return fail('用法：zd edit <id> [--字段 值 …]');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);

  const allowed = EDITABLE[item.kind] || [];
  const patch = {};
  for (const [k, v] of Object.entries(flags)) {
    if (['json', 'color', 'port_hub'].includes(k)) continue;
    if (!allowed.includes(k)) continue;
    patch[k] = v;
  }

  // 没给任何可改字段时，列出能改什么
  if (!Object.keys(patch).length) {
    out(ctx, `${color.bold(id)} 可改字段：${allowed.join(' ')}`);
    out(ctx, color.gray(`例：zd edit ${id} --name "新名字"`));
    return 0;
  }

  if (patch.args !== undefined) patch.args = splitArgs(patch.args);
  if (patch.port !== undefined) {
    const p = Number(patch.port);
    if (!Number.isInteger(p)) return fail('--port 必须是整数');
    patch.port = p;
  }
  if (patch.enabled !== undefined) patch.enabled = patch.enabled !== 'false';

  const merged = { ...item, ...patch };
  delete merged.runtime;

  const errs = validateItem(merged);
  if (errs.length) return fail(errs.join('；'));

  let via;
  try {
    via = await writeItem(ctx, merged);
  } catch (e) {
    return fail(e);
  }

  const keys = Object.keys(patch).join(', ');
  if (ctx.json) {
    emitJson({ ok: true, via, changed: Object.keys(patch), item: merged });
    return 0;
  }
  out(ctx, `${color.green('✓')} 已更新 ${color.bold(id)}（${keys}）`);
  if (item.runtime?.status === 'running') {
    out(ctx, color.yellow('这项正在运行，改动要 zd restart 才生效'));
  }
  return 0;
}

// ---------- rm ----------

export async function cmdRemove(ctx, id, flags) {
  if (!id) return fail('用法：zd rm <id> [-f]');
  const item = await resolveItem(ctx, id);
  if (!item) return fail(`没有这个项：${id}`);

  const force = !!flags.force;
  const running = item.runtime?.status === 'running';

  if (!force && process.stdin.isTTY && !ctx.json) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const extra = running ? color.yellow('（它正在运行，会先被停掉）') : '';
    const ans = await rl.question(`删除 ${color.bold(id)} ${item.name}？${extra} [y/N]: `);
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      out(ctx, color.gray('已取消'));
      return 0;
    }
  }

  try {
    if (await ctx.client.probe()) {
      await ctx.client.removeItem(id);
    } else {
      const cfg = await loadConfig();
      if (!removeItem(cfg, id)) return fail(`没有这个项：${id}`);
      await saveConfig(cfg);
    }
  } catch (e) {
    return fail(e);
  }

  if (ctx.json) {
    emitJson({ ok: true, id });
    return 0;
  }
  out(ctx, `${color.green('✓')} 已删除 ${id}`);
  return 0;
}

// ---------- settings ----------

const SETTING_KEYS = ['openMode', 'closeAction', 'autoStart', 'browser', 'hotkey'];

const SETTING_DESC = {
  openMode: '打开页面的方式：window（带地址栏）/ app（无地址栏）',
  closeAction: '关窗口的行为：quit（退出）/ tray（最小化到托盘）',
  autoStart: '开机自启：true / false（写注册表，需要 .venv）',
  browser: '打开页面用的浏览器路径，空 = 自动（优先 Chrome）',
  hotkey: '唤出拓展坞的全局热键，如 alt+x',
};

export async function cmdSettings(ctx, pairs, flags) {
  const online = await ctx.client.probe();

  // 无参数 = 查看
  if (!pairs.length) {
    let settings;
    let auto = null;
    if (online) {
      const d = await ctx.client.settings();
      settings = d.settings;
      auto = d.autoStart;
    } else {
      const cfg = await loadConfig();
      settings = cfg.settings;
    }

    if (ctx.json) {
      emitJson({ settings, autoStart: auto });
      return 0;
    }
    for (const k of SETTING_KEYS) {
      if (k === 'autoStart') continue;
      out(ctx, `${color.gray(k.padEnd(12))} ${settings?.[k] ?? ''}`);
    }
    if (auto) {
      const state = auto.enabled
        ? auto.stale
          ? color.yellow('已注册（命令是旧的，重设一次会更新）')
          : color.green('已注册')
        : color.gray('未注册');
      out(ctx, `${color.gray('autoStart'.padEnd(12))} ${state}`);
    }
    if (!online) {
      out(ctx, '');
      offlineNote(ctx);
    }
    return 0;
  }

  // 有参数 = 修改，形式 key=value
  const patch = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) return fail(`格式是 key=value，例如 browser=chrome`);
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (!SETTING_KEYS.includes(k)) {
      return fail(`未知设置项：${k}\n可设置：${SETTING_KEYS.join(' ')}`);
    }
    if (k === 'autoStart') {
      const want = v === 'true' || v === '1' || v === 'on';
      if (!online) return fail('开机自启要写注册表，需要 hub 在线（zd up）');
      try {
        const st = await ctx.client.autoStart(want);
        if (ctx.json) emitJson({ ok: true, autoStart: st });
        else out(ctx, `${color.green('✓')} 开机自启${st.enabled ? '已开启' : '已关闭'}`);
      } catch (e) {
        return fail(e);
      }
      continue;
    }
    patch[k] = v;
  }

  if (Object.keys(patch).length) {
    if (online) {
      try {
        await ctx.client.saveSettings(patch);
      } catch (e) {
        return fail(e);
      }
    } else {
      const cfg = await loadConfig();
      cfg.settings = { ...cfg.settings, ...patch };
      await saveConfig(cfg);
    }
    if (ctx.json) emitJson({ ok: true, settings: patch });
    else {
      for (const [k, v] of Object.entries(patch)) {
        out(ctx, `${color.green('✓')} ${k} = ${v}`);
      }
      if (patch.hotkey) {
        out(ctx, color.gray('热键改动要重启桌面外壳才生效'));
      }
    }
  }
  return 0;
}

// ---------- up ----------

export async function cmdUp(ctx) {
  const port = await ctx.client.port();
  if (await ctx.client.probe()) {
    if (ctx.json) emitJson({ ok: true, already: true, port });
    else out(ctx, color.gray(`hub 已经在跑了：http://127.0.0.1:${port}/`));
    return 0;
  }

  if (ctx.json) {
    emitJson({ ok: true, starting: true, port });
  } else {
    out(ctx, color.gray(`前台启动 hub，Ctrl+C 退出（要托盘和拓展坞就双击 zen-dock-window.bat）`));
    out(ctx, '');
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'index.mjs'), '--no-open'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (e) => {
      fail(`启动失败：${e.message}`);
      resolve(1);
    });
  });
}

// ---------- 停止全部 ----------

export async function cmdStopAll(ctx) {
  const items = (await ctx.client.state()).items || [];
  const running = items.filter((i) => i.runtime?.status === 'running');
  if (!running.length) {
    if (!ctx.json) out(ctx, color.gray('没有在跑的项'));
    else emitJson({ ok: true, stopped: 0 });
    return 0;
  }
  try {
    await ctx.client.stopAll();
  } catch (e) {
    return fail(e);
  }
  if (ctx.json) emitJson({ ok: true, stopped: running.length });
  else out(ctx, `${color.green('✓')} 已停止 ${running.length} 项`);
  return 0;
}

export { splitArgs, indent };
