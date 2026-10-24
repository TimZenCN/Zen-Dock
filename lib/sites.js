// lib/sites.js —— 静态页面托管
//
// 挂载在 /s/<id>/ 下。注意一个固有限制：页面里写死的绝对路径（/css/a.css）会
// 404，因为站点根不是域名根。注入 <base> 只能修好相对路径，修不了绝对路径——
// 要彻底解决得给每个站点独立端口或子域，P0 不做。

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sniffHtmlEncoding(buf) {
  const head = buf.subarray(0, 2048).toString('latin1').toLowerCase();
  const m = head.match(/charset\s*=\s*["']?\s*([a-z0-9_-]+)/);
  const enc = m?.[1];
  if (!enc) return 'utf-8';
  if (enc === 'gb2312' || enc === 'gbk' || enc === 'gb18030') return 'gb18030';
  return enc;
}

function injectBase(html, href) {
  const tag = `<base href="${href}">`;
  if (/<base\s/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n${tag}`);
  return tag + html;
}

export async function serveSite(item, subPath, res) {
  const root = path.resolve(item.dir);
  const entry = item.entry || 'index.html';
  let rel = decodeURIComponent(subPath || '/');
  rel = rel.replace(/^\/+/, '');

  let target = path.resolve(root, rel || entry);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越界');
    return;
  }

  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    target = path.join(target, entry);
    info = await stat(target).catch(() => null);
  }

  if (!info) {
    if (item.spa) {
      target = path.join(root, entry);
      info = await stat(target).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 找不到 ${rel || entry}`);
      return;
    }
  }

  const ext = path.extname(target).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    const buf = await readFile(target);
    const enc = sniffHtmlEncoding(buf);
    let text = new TextDecoder(enc).decode(buf);
    if (item.injectBase !== false) {
      text = injectBase(text, `/s/${item.id}/`);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(text);
    return;
  }

  const buf = await readFile(target);
  res.writeHead(200, {
    'Content-Type': mimeOf(target),
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}
