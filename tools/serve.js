#!/usr/bin/env node
/**
 * 极简静态服务器（零依赖）
 * 用法：node tools/serve.js [port]
 * 默认端口 8080
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2], 10) || 8080;
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const safe = path.normalize(urlPath).replace(/^([.][.][\/\\])+/, '');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    let target = file;
    if (err || st.isDirectory()) {
      // 目录 → 找 index.html
      if (st && st.isDirectory()) target = path.join(file, 'index.html');
      else { res.writeHead(404).end('Not Found: ' + urlPath); return; }
    }
    fs.readFile(target, (e, buf) => {
      if (e) { res.writeHead(404).end('Not Found: ' + urlPath); return; }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(buf);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[serve] http://127.0.0.1:' + PORT + '  →  ' + ROOT);
});
