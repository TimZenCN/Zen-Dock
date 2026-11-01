#!/usr/bin/env node
// test-scripts/run.mjs —— 统一测试入口
//
//   npm test            跑离线部分（语法 + 单元测试），不需要 hub、不需要 .venv
//   npm run test:all    再加上需要 hub 的端到端冒烟
//
// 分层的原因：语法和单元测试在任何机器上都该能跑（CI 就跑这个），
// 端到端要起进程、要 Windows 桌面环境，只能本地跑。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const VENV_PY = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

let failed = 0;
let passed = 0;

function step(name, fn) {
  process.stdout.write(`\n── ${name}\n`);
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`  ✗ ${e.message.split('\n').slice(0, 8).join('\n  ')}`);
  }
}

function run(cmd, args, opt = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opt });
}

function nodeCheck(files) {
  const bad = [];
  for (const f of files) {
    try {
      run(process.execPath, ['--check', f]);
    } catch (e) {
      bad.push(`${path.relative(ROOT, f)}\n${e.stderr || e.message}`);
    }
  }
  if (bad.length) throw new Error(bad.join('\n\n'));
  console.log(`  ✓ ${files.length} 个 JS 文件语法通过`);
}

function listJs() {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.venv' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(ent.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'bin'));
  walk(HERE);
  out.push(path.join(ROOT, 'index.mjs'));
  return out.filter((f) => existsSync(f));
}

function pyCheck() {
  if (!existsSync(VENV_PY)) {
    console.log('  – 跳过（没有 .venv）');
    return;
  }
  const files = readdirSync(path.join(ROOT, 'shell'))
    .filter((f) => f.endsWith('.py'))
    .map((f) => path.join('shell', f));
  run(VENV_PY, ['-m', 'py_compile', ...files]);
  console.log(`  ✓ ${files.length} 个 Python 文件语法通过`);
}

function runTest(file) {
  const out = run(process.execPath, [path.join('test-scripts', file)]);
  const last = out.trimEnd().split('\n').pop();
  console.log(`  ✓ ${file}  ${last}`);
}

async function hubAlive() {
  try {
    const res = await fetch('http://127.0.0.1:7717/api/state', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- 离线部分 ----

step('JS 语法', () => nodeCheck(listJs()));
step('Python 语法', pyCheck);
step('日志落盘', () => runTest('logs.mjs'));
step('服务指纹匹配', () => runTest('dedupe.mjs'));

// ---- 需要 hub 的部分 ----

if (process.argv.includes('--all')) {
  if (!(await hubAlive())) {
    console.log('\n── 端到端冒烟\n  – 跳过（hub 没在跑，先 node index.mjs）');
  } else {
    step('三种 shell 冒烟', () => runTest('smoke.mjs'));
    step('服务启动去重', () => runTest('dedupe-e2e.mjs'));
  }
}

console.log(`\n${failed === 0 ? '✓ 全过' : '✗ 有失败'}  ${passed} 组通过 / ${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
