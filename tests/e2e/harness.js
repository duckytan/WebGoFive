/**
 * E2E 基座：puppeteer-core 驱动本地 Edge + 静态服务
 *
 * 用法（每个套件）：
 *   const { boot, shutdown, openPage, clickCell, setPosition, makeAsserter } = require('./harness');
 *   const t = makeAsserter('01 load');
 *   await boot();
 *   const ctx = await openPage();
 *   ...
 *   await shutdown();
 *
 * 环境变量 GMK_E2E_VERBOSE=1 打印每条断言。
 */
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/EdgeCore/155.0.4283.62/msedge.exe';

let puppeteer = null;
let server = null;
let browser = null;

/* ---------------- 静态服务（零依赖） ---------------- */
// 端口用 0 让内核分配空闲端口：避免多次跑测试时 8123 处于 TIME_WAIT
// 导致 EADDRINUSE（曾连续两次撞车，中断整轮验收）
let BASE_URL = '';

function startServer() {
    return new Promise((resolve, reject) => {
        const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png' };
        server = http.createServer((req, res) => {
            let p;
            try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
            if (p === '/') p = '/index.html';
            const file = path.join(ROOT, path.normalize(p));
            if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
            fs.readFile(file, (e, buf) => {
                if (e) { res.writeHead(404).end('404 ' + p); return; }
                const ext = path.extname(file).toLowerCase();
                res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
                res.end(buf);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            BASE_URL = 'http://127.0.0.1:' + port;
            resolve(BASE_URL);
        });
        server.on('error', reject);
    });
}

async function boot() {
    if (server) return;
    await startServer();
    puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
}

async function shutdown() {
    if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
    if (server) { try { server.close(); } catch (e) {} server = null; }
}

/** 开一个新标签页，等 demo/game/renderer 就绪 */
async function openPage() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
    await page.goto(BASE_URL + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.demo && window.game && window.boardRenderer', { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    return { page, errors, shutdown: async () => { await page.close(); } };
}

/**
 * 在页面里按「格子坐标」点棋盘
 * @param {{wait?: boolean}} [opts] wait=false 时点完立刻返回，不等 AI 落子。
 *        用于验证「先显示玩家落子，AI 再开始思考」：点完瞬间必须只剩玩家这一手。
 */
async function clickCell(page, x, y, opts) {
    const pos = await page.evaluate((gx, gy) => {
        const r = window.boardRenderer;
        const rect = r.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // canvas.width 含 DPR，rect.width 是 CSS 像素；内部坐标(不含DPR)→CSS像素 的换算
        const sx = rect.width / (r.canvas.width / dpr);
        const sy = rect.height / (r.canvasHeight / dpr);
        return { x: rect.left + (r.padding + gx * r.cellSize) * sx,
                 y: rect.top + (r.padding + gy * r.cellSize) * sy };
    }, x, y);
    await page.mouse.click(pos.x, pos.y);
    if (opts && opts.wait === false) return;
    // AI 回一手的时间（PvE/EvE）
    await page.waitForFunction('!window.demo || !window.demo.aiThinking', { timeout: 6000 }).catch(() => {});
}

/** 摆一个局面（直接改 game.board + 同步 moves 历史 + 当前行棋方） */
async function setPosition(page, stones, { mode = 'PvP', currentPlayer = 1 } = {}) {
    await page.evaluate((st, m, cp) => {
        const g = window.game;
        g.reset();
        g.setGameMode(m);
        // 上一局的结算弹窗是 inset:0 的遮罩，不关掉会挡住后续点击
        if (window.demo && window.demo.closeResultModal) window.demo.closeResultModal();
        g.board = g.board.map(r => r.slice());
        for (const [x, y, p] of st) { g.board[y][x] = p; g.moves.push({ x, y, player: p, step: g.moves.length + 1, timestamp: 0 }); }
        g.currentPlayer = cp;
        g.gameStatus = st.length ? 'playing' : 'ready';
        if (st.length) { g.startTime = Date.now(); }
        if (window.demo) window.demo._render();
    }, stones, mode, currentPlayer);
    await new Promise(r => setTimeout(r, 150));
}

/** 读棋盘某点 */
async function stoneAt(page, x, y) {
    return page.evaluate(([xx, yy]) => window.game.board[yy][xx], [x, y]);
}

function makeAsserter(label) {
    const t = { label: label || '', pass: 0, fail: 0, failures: [], steps: [] };
    const V = process.env.GMK_E2E_VERBOSE === '1';
    t.ok = (cond, msg, extra) => {
        if (cond) { t.pass++; if (V) console.log('  ✓ ' + msg); return true; }
        t.fail++; t.failures.push(msg + (extra !== undefined ? ' [' + extra + ']' : ''));
        if (V || true) console.log('  ✗ ' + msg + (extra !== undefined ? ' [' + extra + ']' : ''));
        return false;
    };
    t.eq = (a, b, msg) => t.ok(a === b, msg, JSON.stringify(a) + ' !== ' + JSON.stringify(b));
    t.step = (s) => t.steps.push(s);
    t.summary = () => '【' + t.label + '】' + t.pass + ' 通过 / ' + t.fail + ' 失败' + (t.failures.length ? '：' + t.failures.join(' | ') : '');
    return t;
}

async function runSuite(name, fn, pageOpts) {
    const t = makeAsserter(name);
    let ctx = null;
    try {
        ctx = await openPage(pageOpts);
        await fn(t, ctx);
    } catch (e) {
        t.fail++;
        t.failures.push('SUITE ERROR ' + e.message);
        console.error('  ✗ suite error: ' + e.stack);
    } finally {
        if (ctx) await ctx.shutdown();
        console.log(t.summary());
    }
    return t;
}

module.exports = { boot, shutdown, openPage, clickCell, setPosition, stoneAt, makeAsserter, runSuite, ROOT, EDGE, getBaseUrl: () => BASE_URL };
