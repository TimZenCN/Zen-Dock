// test-scripts/smoke.mjs —— 三种 shell 的冒烟测试
// 用法：先启动 hub，再 node test-scripts/smoke.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:7717';
// 从本文件位置推导，换机器/换盘符都不用改
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path} → ${d?.error || r.status}`);
  return d;
}

const cases = [
  { id: 'smoke-py', name: '冒烟 Python', shell: 'python', file: 't.py' },
  { id: 'smoke-bat', name: '冒烟 BAT', shell: 'bat', file: 't.bat' },
  { id: 'smoke-ps', name: '冒烟 PS1', shell: 'powershell', file: 't.ps1' },
];

let failed = 0;

for (const c of cases) {
  await api('/api/items', {
    method: 'POST',
    body: JSON.stringify({
      id: c.id,
      kind: 'script',
      name: c.name,
      shell: c.shell,
      path: path.join(FIXTURES, c.file),
      cwd: FIXTURES,
    }),
  });

  await api(`/api/items/${c.id}/run`, { method: 'POST', body: '{}' });

  let st;
  for (let i = 0; i < 60; i++) {
    st = await api(`/api/items/${c.id}`);
    if (st.runtime.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const { lines } = await api(`/api/items/${c.id}/logs?since=0`);
  console.log(`\n=== ${c.name} [${c.shell}] status=${st.runtime.status} exit=${st.runtime.exitCode} ===`);
  for (const l of lines) {
    const tag = l.stream === 'err' ? 'ERR' : l.stream === 'sys' ? 'sys' : 'out';
    console.log(`  ${tag.padEnd(3)} ${l.text}`);
  }

  const hasChinese = lines.some((l) => /中文/.test(l.text));
  const garbled = lines.some((l) => l.text.includes('\uFFFD'));
  if (!hasChinese) {
    console.log('  ✗ 没抓到中文输出');
    failed++;
  } else if (garbled) {
    console.log('  ✗ 中文乱码（出现替换字符）');
    failed++;
  } else {
    console.log('  ✓ 中文正常');
  }
}

for (const c of cases) {
  await api(`/api/items/${c.id}`, { method: 'DELETE' }).catch(() => {});
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
