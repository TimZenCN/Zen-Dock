#!/usr/bin/env node
// bin/zd.mjs —— Zen-Dock 命令行
//
// 零依赖。管理 hub 里已有的项，也能注册新的。
// 控制类命令走 HTTP（进程状态在 hub 内存里），配置类命令直接读写 hub.config.json。

import { readFileSync } from 'node:fs';
import { HubClient, HubOfflineError } from '../lib/cli/client.js';
import { setColor, color, padRight, visibleWidth } from '../lib/cli/format.js';
import * as cmd from '../lib/cli/commands.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ---------- 命令表 ----------

const COMMANDS = {
  list: {
    aliases: ['ls', 'ps'],
    group: '查看',
    summary: '列出所有项和状态（默认命令）',
    usage: 'zd list',
    detail: 'hub 在线时带真实运行状态；hub 没跑也能用，只显示配置里的定义。',
  },
  status: {
    group: '查看',
    summary: 'hub 自身的状态',
    usage: 'zd status',
    detail: '显示 hub 是否在跑、地址、项数、以及正在运行的进程列表。',
  },
  show: {
    group: '查看',
    summary: '单项详情',
    usage: 'zd show <id>',
    detail: '打印完整配置和运行时信息（pid、运行时长、退出码）。',
  },
  start: {
    group: '运行',
    summary: '启动一个服务，等端口探活通过才返回',
    usage: 'zd start <id>',
    detail:
      '不是 spawn 完就报成功——会等到 TCP 能连上（默认 15s 超时）才显示已启动。\n启动失败会打印日志提示。',
  },
  stop: {
    group: '运行',
    summary: '停止服务（taskkill 整棵进程树）',
    usage: 'zd stop <id>',
    detail: 'Windows 上没有优雅停止，这里就是强杀进程树。孙进程也一起清掉。',
  },
  restart: {
    group: '运行',
    summary: '重启',
    usage: 'zd restart <id>',
    detail: '先 stop 再 start。',
  },
  run: {
    group: '运行',
    summary: '运行一个脚本，参数按脚本声明的 params 映射',
    usage: 'zd run <id> [--参数 值 …]',
    detail:
      '例：zd run deploy --port 9000\n只会接受脚本 params 里声明过的参数，写错了会列出可用参数。\nCtrl+C 会终止脚本。',
  },
  logs: {
    group: '运行',
    summary: '看日志，-f 实时跟随',
    usage: 'zd logs <id> [-f] [-n 50]',
    detail:
      'stdout 和 stderr 混排，靠颜色区分。\n-f 是跟随模式，Ctrl+C 只断开跟随，不会杀掉进程。',
  },
  open: {
    group: '运行',
    summary: '用配置的浏览器打开页面',
    usage: 'zd open <id>',
    detail: '走服务端 spawn，窗口形态由设置里的「打开页面的方式」决定（window / app）。',
  },
  add: {
    group: '注册',
    summary: '注册新项；不带参数进交互向导',
    usage: 'zd add [service|script|page] <id> [选项]',
    detail:
      '不带任何参数：逐项询问，适合手动登记。\n带参数：直接写入，适合脚本和 AI 调用。\n\n' +
      'service 选项：\n' +
      '  --name <名称>        显示名，默认同 id\n' +
      '  --cmd <命令>         必填，如 node / python / npm\n' +
      '  --args "<参数>"      参数，空格分隔，含空格的用引号\n' +
      '  --cwd <目录>         工作目录\n' +
      '  --port <端口>        监听端口，用于启动探活\n' +
      '  --url <地址>         打开页面时的地址\n\n' +
      'script 选项：\n' +
      '  --shell <类型>       powershell / python / bat，默认 powershell\n' +
      '  --path <路径>        必填，脚本文件路径\n' +
      '  --cwd <目录>         工作目录\n\n' +
      'page 选项：\n' +
      '  --dir <目录>         必填，静态页面目录\n' +
      '  --entry <文件>       入口，默认 index.html\n\n' +
      '例：\n' +
      '  zd add service relay --name "Relay" --cmd node --args "index.mjs" --port 8787\n' +
      '  zd add script deploy --name "部署" --shell powershell --path "run.ps1"\n' +
      '  zd add page notes --name "笔记" --dir "./sites/notes"',
  },
  edit: {
    group: '注册',
    summary: '改一个项',
    usage: 'zd edit <id> --字段 值 …',
    detail:
      '可改字段跟类型有关：\n' +
      '  service: name cmd args cwd port url enabled\n' +
      '  script:  name shell path cwd enabled\n' +
      '  page:    name dir entry enabled\n\n' +
      '不给字段时只列出能改什么。正在运行的项改完要 zd restart 才生效。',
  },
  rm: {
    group: '注册',
    summary: '删除一个项',
    usage: 'zd rm <id> [-f]',
    detail: '运行中的项会先被停掉。终端里会二次确认，-f 跳过。',
  },
  settings: {
    group: '系统',
    summary: '查看或修改全局设置',
    usage: 'zd settings [key=value …]',
    detail:
      '可设置的键：\n' +
      '  openMode      window / app        打开页面的方式\n' +
      '  closeAction   quit / tray         关窗口时退出还是最小化到托盘\n' +
      '  browser       <浏览器路径>         空 = 自动（优先 Chrome）\n' +
      '  hotkey        <组合键>            唤出拓展坞，如 alt+x（重启外壳生效）\n' +
      '  autoStart     true / false        开机自启（写注册表）\n\n' +
      '例：zd settings browser="C:/Program Files/Google/Chrome/Application/chrome.exe"',
  },
  up: {
    group: '系统',
    summary: '前台启动 hub',
    usage: 'zd up',
    detail:
      '跑 node index.mjs --no-open，Ctrl+C 退出。\n' +
      '要托盘和拓展坞，请双击 zen-dock-window.bat（那是桌面外壳，不是这个）。',
  },
  'stop-all': {
    group: '系统',
    summary: '停掉所有正在运行的服务和脚本',
    usage: 'zd stop-all',
    detail: '会强杀所有进程树。hub 自己不受影响。',
  },
  help: {
    aliases: ['-h', '--help'],
    group: '系统',
    summary: '帮助',
    usage: 'zd help [命令]',
    detail: '不带参数看全部命令，带命令名看那个命令的完整用法。',
  },
};

const ALIAS_MAP = {};
for (const [name, meta] of Object.entries(COMMANDS)) {
  for (const a of meta.aliases || []) ALIAS_MAP[a] = name;
}

// 这些选项后面一定跟一个值，即使值以 - 开头
const VALUE_FLAGS = new Set([
  'hub-port',
  'name',
  'cmd',
  'args',
  'cwd',
  'port',
  'url',
  'shell',
  'path',
  'dir',
  'entry',
  'lines',
  'hotkey',
  'browser',
  'openMode',
  'closeAction',
]);

const SHORT_FLAGS = {
  f: 'follow',
  n: 'lines',
  h: 'help',
  j: 'json',
};

// ---------- 参数解析 ----------

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  let passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }

    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // 只有已知要带值的选项才吃下一个 token。未知选项一律当布尔，
      // 否则 `zd --json list` 会把 list 当成 --json 的值。
      if (VALUE_FLAGS.has(body)) {
        flags[body] = argv[i + 1] ?? '';
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const short = a.slice(1);
      const mapped = SHORT_FLAGS[short];
      if (mapped) {
        if (mapped === 'lines') {
          flags[mapped] = argv[++i] ?? '';
        } else {
          flags[mapped] = true;
        }
      } else {
        flags[short] = true;
      }
      continue;
    }

    positional.push(a);
  }

  return { flags, positional, passthrough };
}

// ---------- 帮助 ----------

function printShortHelp() {
  const lines = [];
  lines.push(`${color.bold('zd')} ${color.gray(`· Zen-Dock 命令行 v${pkg.version}`)}`);
  lines.push('');
  lines.push(`  ${color.gray('zd')}                       列出所有项（最常用）`);
  lines.push(`  ${color.gray('zd start <id>')}            启动服务`);
  lines.push(`  ${color.gray('zd stop <id>')}             停止服务`);
  lines.push(`  ${color.gray('zd logs <id> -f')}          实时看日志`);
  lines.push(`  ${color.gray('zd add')}                   注册新项（交互向导）`);
  lines.push(`  ${color.gray('zd up')}                    前台启动 hub`);
  lines.push('');
  lines.push(`  ${color.gray('zd help')}                  全部命令`);
  lines.push(`  ${color.gray('zd help <命令>')}           某个命令的完整用法`);
  process.stdout.write(lines.join('\n') + '\n');
}

function printFullHelp() {
  const groups = new Map();
  for (const [name, meta] of Object.entries(COMMANDS)) {
    if (!groups.has(meta.group)) groups.set(meta.group, []);
    groups.get(meta.group).push([name, meta]);
  }

  const lines = [];
  lines.push(`${color.bold('zd')} ${color.gray(`Zen-Dock 命令行 v${pkg.version}`)}`);
  lines.push('');
  lines.push(color.gray('用法: zd <命令> [参数] [选项]'));

  for (const [group, list] of groups) {
    lines.push('');
    lines.push(color.bold(group));
    const width = Math.max(...list.map(([n, m]) => visibleWidth(m.usage || n)));
    for (const [name, meta] of list) {
      const usage = meta.usage || name;
      const alias = meta.aliases?.length ? color.gray(` (${meta.aliases.join(', ')})`) : '';
      lines.push(`  ${padRight(usage, width)}  ${meta.summary}${alias}`);
    }
  }

  lines.push('');
  lines.push(color.bold('全局选项'));
  lines.push(`  ${padRight('--json', 12)}  输出 JSON，方便管道和脚本`);
  lines.push(`  ${padRight('--no-color', 12)}  关掉颜色`);
  lines.push(`  ${padRight('--hub-port <n>', 12)}  指定 hub 端口（默认读配置）`);
  lines.push('');
  lines.push(color.gray('所有命令都支持 --json。完整用法：zd help <命令>'));
  process.stdout.write(lines.join('\n') + '\n');
}

function printCommandHelp(name) {
  const key = ALIAS_MAP[name] || name;
  const meta = COMMANDS[key];
  if (!meta) {
    process.stderr.write(color.red(`zd: 没有这个命令：${name}`) + '\n');
    process.stderr.write(color.gray('看看 zd help') + '\n');
    return 1;
  }
  const lines = [];
  lines.push(`${color.bold(meta.usage)}`);
  lines.push('');
  lines.push(`  ${meta.summary}`);
  if (meta.detail) {
    lines.push('');
    lines.push(
      meta.detail
        .split('\n')
        .map((l) => (l ? '  ' + l : l))
        .join('\n')
    );
  }
  if (meta.aliases?.length) {
    lines.push('');
    lines.push(color.gray(`别名：${meta.aliases.join(', ')}`));
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

// ---------- 主流程 ----------

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2));

  if (flags['no-color'] || process.env.NO_COLOR) {
    setColor(false);
  } else if (!process.stdout.isTTY) {
    setColor(false);
  }

  const ctx = {
    // 注意：--port 是 item 的端口（add/edit 用），hub 端口是 --hub-port，两者不能共用
    client: new HubClient({ port: flags['hub-port'] ? Number(flags['hub-port']) : null }),
    json: !!flags.json,
  };

  let command = positional[0] || 'list';
  const rest = positional.slice(1);

  if (flags.help && command !== 'help') {
    return printCommandHelp(command);
  }

  command = ALIAS_MAP[command] || command;

  if (command === 'help') {
    if (!rest.length) {
      printFullHelp();
      return 0;
    }
    return printCommandHelp(rest[0]);
  }

  // 无参数调用 zd 且没给子命令时，如果带了 --help 已经处理过了
  switch (command) {
    case 'list':
      return cmd.cmdList(ctx);
    case 'status':
      return cmd.cmdStatus(ctx);
    case 'show':
      return cmd.cmdShow(ctx, rest[0]);
    case 'start':
      return cmd.cmdStart(ctx, rest[0]);
    case 'stop':
      return cmd.cmdStop(ctx, rest[0]);
    case 'restart':
      return cmd.cmdRestart(ctx, rest[0]);
    case 'run':
      return cmd.cmdRun(ctx, rest[0], flags);
    case 'logs':
      return cmd.cmdLogs(ctx, rest[0], {
        follow: !!flags.follow,
        lines: flags.lines ?? 50,
      });
    case 'open':
      return cmd.cmdOpen(ctx, rest[0]);
    case 'add':
      return cmd.cmdAdd(ctx, rest, flags);
    case 'edit':
      return cmd.cmdEdit(ctx, rest[0], flags);
    case 'rm':
      return cmd.cmdRemove(ctx, rest[0], flags);
    case 'settings':
      return cmd.cmdSettings(ctx, rest, flags);
    case 'up':
      return cmd.cmdUp(ctx);
    case 'stop-all':
      return cmd.cmdStopAll(ctx);
    default:
      process.stderr.write(color.red(`zd: 没有这个命令：${command}`) + '\n');
      process.stderr.write(color.gray('看看 zd help') + '\n');
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    if (e instanceof HubOfflineError) {
      process.stderr.write(color.red(`zd: ${e.message}`) + '\n');
      process.stderr.write(color.gray('起一个：zd up      或者双击 zen-dock-window.bat') + '\n');
      process.exitCode = 2;
      return;
    }
    process.stderr.write(color.red(`zd: ${e.message}`) + '\n');
    if (process.env.ZD_DEBUG) process.stderr.write(e.stack + '\n');
    process.exitCode = 1;
  });
