// 进程指纹匹配自测：node test-scripts/dedupe.mjs
//
// 覆盖配置里常见的写法差异：正/反斜杠、带不带 .exe、绝对/相对路径、引号、
// 参数顺序，以及"不该误命中"的反例。服务去重全靠这个判断，
// 判错要么漏杀（起两个），要么误杀（接管了别的进程）。

import { fingerprint, looksLike } from '../lib/services.js';

let pass = 0;
let fail = 0;

function t(name, item, cmdline, want) {
  const fp = fingerprint(item);
  const got = fp ? looksLike(cmdline, fp) : null;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  got=${got} want=${want}`}`);
}

// relay：配置写 node + 相对入口，实际命令行是绝对路径的 node.EXE
t('relay 命中', { cmd: 'node', args: ['index.mjs'] },
  '"C:\\node\\node.EXE" index.mjs --no-open --port 8787', true);
t('relay 不命中别的入口', { cmd: 'node', args: ['index.mjs'] },
  '"C:\\node\\node.EXE" server.js --port 8787', false);
t('relay 不被 python 命中', { cmd: 'node', args: ['index.mjs'] },
  '"C:\\Python313\\python.exe" index.mjs', false);

// dsh-web：配置里用正斜杠写绝对路径，命令行里是反斜杠
t('正斜杠配置命中反斜杠命令行',
  { cmd: 'node', args: ['C:/node/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open'] },
  '"C:\\node\\node.exe" "C:\\node\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open',
  true);
t('缺参数不命中',
  { cmd: 'node', args: ['bin.js', 'web', '--no-open'] },
  '"C:\\node\\node.exe" "C:\\node\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web',
  false);

// 配置里写 node.exe
t('配置写 node.exe 也能命中', { cmd: 'node.exe', args: ['index.mjs'] },
  '"C:\\node\\node.exe" index.mjs', true);

// 参数顺序无关
t('参数顺序无关', { cmd: 'node', args: ['web', '--no-open'] },
  'node bin.js --no-open web', true);

// 不该误命中
t('不误命中 nodejs', { cmd: 'node', args: [] }, 'nodejs-helper.exe', false);
t('不误命中 mynode', { cmd: 'node', args: [] }, 'C:\\tools\\mynode.exe', false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
