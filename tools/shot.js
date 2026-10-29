/**
 * 截图工具：跑一遍页面并把各分页截图存到 reports/
 * 用法：node tools/shot.js
 */
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/EdgeCore/155.0.4283.62/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, path.normalize(p));
    fs.readFile(file, (e, buf) => {
        if (e) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
    });
});

server.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.demo && window.game', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 600));

    // 造一个有内容的中局：黑棋走一个活三
    await page.evaluate(() => {
        window.demo.setTheme('wood');
        const g = window.game;
        g.reset();
        g.setGameMode('PvP');
        const st = [[7, 7, 1], [7, 8, 2], [8, 7, 1], [8, 8, 2], [9, 7, 1], [6, 9, 2], [9, 9, 1]];
        for (const [x, y, p] of st) g.placePiece(x, y);
        window.demo._render();
    });
    await new Promise(r => setTimeout(r, 300));

    fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
    const shots = [];
    for (const tab of ['game', 'practice', 'analysis', 'settings']) {
        await page.evaluate(t => window.demo.showTab(t), tab);
        await new Promise(r => setTimeout(r, 250));
        const f = path.join(ROOT, 'reports', 'ui-' + tab + '.png');
        await page.screenshot({ path: f });
        shots.push(f);
    }

    // 复盘态
    await page.evaluate(() => { window.demo.showTab('game'); document.querySelectorAll('#move-list li.mv-item')[2].click(); });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(ROOT, 'reports', 'ui-review.png') });

    // 移动端
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.evaluate(() => { document.getElementById('rp-exit').click(); window.demo.showTab('practice'); });
    await new Promise(r => setTimeout(r, 350));
    await page.screenshot({ path: path.join(ROOT, 'reports', 'ui-mobile.png'), fullPage: true });

    await browser.close();
    server.close();
    console.log('截图完成：' + shots.concat(['ui-review.png', 'ui-mobile.png']).join(', '));
});
