// lib/cli/format.js —— 终端输出
//
// 两个必须自己处理的事：
// 1. 中文是双宽字符，用 str.length 算列宽会把表格撑歪
// 2. 着色后的字符串长度包含 ANSI 转义序列，算宽度前必须剥掉

const ANSI_RE = /\x1b\[[0-9;]*m/g;

let colorEnabled = true;

export function setColor(on) {
  colorEnabled = !!on;
}

export function colorOn() {
  return colorEnabled;
}

function paint(code, s) {
  if (!colorEnabled) return String(s);
  return `\x1b[${code}m${s}\x1b[0m`;
}

export const color = {
  green: (s) => paint('32', s),
  red: (s) => paint('31', s),
  yellow: (s) => paint('33', s),
  blue: (s) => paint('34', s),
  cyan: (s) => paint('36', s),
  gray: (s) => paint('90', s),
  bold: (s) => paint('1', s),
  dim: (s) => paint('2', s),
};

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// 单个码点的显示宽度。CJK / 全角 / emoji 占两列。
function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x1100) return 1;
  if (
    cp <= 0x115f || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK 部首 … 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排标点
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

function padTo(s, width, align = 'left') {
  const gap = width - visibleWidth(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + s + ' '.repeat(gap - left);
  }
  return s + ' '.repeat(gap);
}

// 给外部（比如 help 文本）用的右补空格，按显示宽度算
export function padRight(s, width) {
  return padTo(s, width, 'left');
}

/**
 * 渲染表格。列之间用两个空格分隔，不用竖线 —— 终端里竖线太吵。
 * columns: [{ title, align }]，rows 是二维数组（单元格可以是已着色的字符串）
 */
export function table(columns, rows) {
  if (!rows.length) return '';
  const widths = columns.map((c, i) => {
    const cellMax = rows.reduce((m, r) => Math.max(m, visibleWidth(r[i] ?? '')), 0);
    return Math.max(visibleWidth(c.title), cellMax);
  });
  const renderRow = (cells, decorate) =>
    cells
      .map((cell, i) => {
        const text = cell ?? '';
        const padded = padTo(text, widths[i], columns[i].align || 'left');
        return decorate ? decorate(padded, i) : padded;
      })
      .join('  ')
      .replace(/\s+$/, '');

  const head = renderRow(
    columns.map((c) => c.title),
    (s) => color.gray(s)
  );
  const sep = color.gray(widths.map((w) => '─'.repeat(w)).join('  '));
  const body = rows.map((r) => renderRow(r));
  return [head, sep, ...body].join('\n');
}

const STATUS_TEXT = {
  running: ['●', '运行中', 'green'],
  starting: ['◐', '启动中', 'yellow'],
  stopping: ['◐', '停止中', 'yellow'],
  stopped: ['○', '已停止', 'gray'],
  idle: ['○', '空闲', 'gray'], // 脚本跑完后的状态，跟服务的 stopped 区分开
  crashed: ['✕', '已崩溃', 'red'],
  failed: ['✕', '启动失败', 'red'],
};

export function statusText(status) {
  const hit = STATUS_TEXT[status];
  if (!hit) return color.gray('—');
  const [dot, label, clr] = hit;
  return color[clr](`${dot} ${label}`);
}

export function kindText(kind) {
  const map = { service: '服务', script: '脚本', page: '页面' };
  return map[kind] || kind;
}

export function humanDuration(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, '0')}h`;
}

export function clockTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 日志行：时间戳灰、stderr 红、系统消息蓝
export function formatLogLine(entry) {
  const ts = color.gray(clockTime(entry.ts));
  const text = entry.text ?? '';
  if (entry.stream === 'err') return `${ts}  ${color.red(text)}`;
  if (entry.stream === 'sys') return `${ts}  ${color.blue(text)}`;
  return `${ts}  ${text}`;
}

export function indent(text, n = 2) {
  const pad = ' '.repeat(n);
  return String(text)
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}
