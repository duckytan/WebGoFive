/**
 * v2.8.1 fresh-eyes 最终独立验收（QA / Edward）
 *
 * 目标：证伪「Worker 静默回退被当成成功」。
 *
 * 设计要点（全部只读产品代码，脚本自带独立静态服务）：
 *  1. 独立静态服务支持 URL 前缀（域名根 / /sub/path/），并记录**服务端收到的
 *     每个请求及响应状态**。这是不依赖 CDP target 归属的端到端硬证据：
 *     Worker 是惰性创建的，所以在「页面就绪后清空日志 → 调 run()」这个时间窗内
 *     出现的请求，必然是 Worker 入口 + importScripts，不会与页面 <script> 混淆。
 *  2. 负向对照：对 deep-eval-worker.js 注入 404（服务端注入对任意 target 生效；
 *     同时按 team-lead 指定启用 page.setRequestInterception 记录是否命中 worker URL），
 *     断言 via !== 'worker' 且结果结构正常 —— 证明 fallback 可观测、via 非常量。
 *  3. 正常路径：**显式 page.reload()** 清 workerBroken 单例后再测。
 *  4. 隔离 SW 缓存：sw.js 是 cache-first（sw.js:91-103），若 SW 命中缓存则服务端
 *     观测不到 Worker 的 importScripts 请求，验收会失去区分力。故 QA 独立服务对
 *     /sw.js 返回 404（register 的 .catch(()=>{}) 会静默吞掉），并对所有响应发
 *     no-store + 在 page CDP session 上禁用缓存 / bypass SW。**被测 Worker 逻辑零改动**。
 *  5. puppeteer 24.x 内部已用 flatten 模式管理 target，在 browser target 上重复
 *     Target.setAutoAttach 会干扰其生命周期；故不启用 browser-level autoAttach，
 *     改以 page.on('workercreated') + 服务端请求日志作为硬证据（team-lead 方案中的
 *     「或独立静态服务端日志」分支），并如实记录该降级。
 *
 * 用法：node tests/qa/final-2.8.1-audit.js
 * 产物：stdout 结构化摘要 + tests/qa/final-2.8.1-audit.log（完整 trace）
 */
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/EdgeCore/155.0.4283.62/msedge.exe';
const puppeteer = require('puppeteer-core');

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.png': 'image/png', '.md': 'text/plain'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 独立静态服务（支持前缀 / 404 注入 / 请求日志） ---------------- */
function startServer(prefix) {
    const log = [];
    let blockWorker = false;
    const server = http.createServer((req, res) => {
        let p;
        try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
        catch (e) { res.writeHead(400).end(); return; }

        let inPrefix = true;
        if (prefix) {
            if (p === prefix || p.startsWith(prefix + '/')) p = p.slice(prefix.length) || '/';
            else inPrefix = false;
        }
        if (!inPrefix) {
            log.push({ url: req.url, status: 404, tag: 'outside-prefix' });
            res.writeHead(404, { 'Cache-Control': 'no-store' }).end('404 outside prefix'); return;
        }
        if (p === '/') p = '/index.html';

        // QA 夹具：隔离 Service Worker（cache-first 会掩盖 worker importScripts 请求）。
        if (p === '/sw.js') {
            log.push({ url: req.url, status: 404, tag: 'sw-isolated' });
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
                .end('sw.js isolated by QA fixture');
            return;
        }

        if (blockWorker && /deep-eval-worker\.js$/.test(p)) {
            log.push({ url: req.url, status: 404, tag: 'injected-404' });
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
                .end('404 injected by QA');
            return;
        }
        const file = path.join(ROOT, path.normalize(p));
        if (!file.startsWith(ROOT)) {
            log.push({ url: req.url, status: 403, tag: 'traversal' });
            res.writeHead(403, { 'Cache-Control': 'no-store' }).end(); return;
        }
        fs.readFile(file, (e, buf) => {
            const status = e ? 404 : 200;
            log.push({ url: req.url, status: status, tag: e ? 'missing' : 'served' });
            if (e) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('404 ' + p); return; }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-store, must-revalidate'
            });
            res.end(buf);
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            log,
            setBlock: v => { blockWorker = v; },
            clear: () => { log.length = 0; },
            close: () => new Promise(r => server.close(r))
        }));
    });
}

/* ---------------- 页面准备 ---------------- */
const READY = 'window.GMK && window.GMK.DeepEval && window.GMK.Analysis';
function waitReady(page) {
    return page.waitForFunction(READY, { timeout: 10000 });
}

async function newPage(browser, baseUrl, trace) {
    const ctx = await browser.createBrowserContext();   // 独立存储，避免 SW/HTTP 缓存串扰
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => trace.pageErrors.push('PAGEERROR ' + e.message));
    page.on('console', m => { if (m.type() === 'error') trace.pageErrors.push('CONSOLE ' + m.text()); });
    page.on('workercreated', w => {
        try { trace.workers.push({ url: w.url() }); }
        catch (e) { trace.workers.push({ url: '(url unavailable)' }); }
    });
    const pageCDP = await page.createCDPSession();
    try {
        await pageCDP.send('Network.enable');
        await pageCDP.send('Network.setCacheDisabled', { cacheDisabled: true });
        await pageCDP.send('Network.setBypassServiceWorker', { bypass: true });
        trace.pageNetwork = 'ok (cacheDisabled + bypassSW)';
    } catch (e) { trace.pageNetwork = 'FAILED: ' + e.message; }
    await page.goto(baseUrl + '/index.html', { waitUntil: 'load' });
    await waitReady(page);
    await sleep(300);
    return { ctx, page };
}

/** 调一次 DeepEval.run；返回 {best, ranking, via}。evaluate 会自动 await Promise。 */
async function callRun(page) {
    return page.evaluate(async () => {
        const b = Array.from({ length: 15 }, () => new Array(15).fill(0));
        b[7][7] = 1; b[7][8] = 2; b[8][7] = 1; b[6][6] = 2; b[5][7] = 1;
        return window.GMK.DeepEval.run(b, 1, { timeMs: 300, depth: 6, candidates: 8 });
    });
}

const IMPORT_TARGETS = [
    'constants.js', 'board.js', 'evaluator.js', 'search.js',
    'kill.js', 'forbidden.js', 'gomoku-ai.js'   // 7 个引擎（worker 内 ../engine/）
];

function analyseWindow(log, prefix) {
    const workerEntry = log.filter(x => /deep-eval-worker\.js$/.test(x.url));
    const engineReq = log.filter(x => IMPORT_TARGETS.some(t => new RegExp('/js/engine/' + t.replace('.', '\\.') + '$').test(x.url)));
    const analysisReq = log.filter(x => /\/js\/app\/analysis\.js$/.test(x.url));
    const workerSide = workerEntry.concat(engineReq, analysisReq);
    const urls = workerSide.map(x => x.url);
    const uniqTargets = new Set(urls).size;
    const bad = workerSide.filter(x => x.status >= 400);
    return {
        totalRequestsInWindow: log.length,
        workerEntryCount: workerEntry.length,
        engineRequestCount: engineReq.length,
        analysisRequestCount: analysisReq.length,
        workerSideRequestCount: workerSide.length,
        distinctWorkerSideUrls: uniqTargets,
        expectedDistinct: 9,
        zero4xx: bad.length === 0,
        bad: bad,
        allUrlsHavePrefix: prefix ? urls.every(u => u.startsWith(prefix)) : true,
        urls: urls,
        fullWindow: log.map(x => ({ url: x.url, status: x.status, tag: x.tag }))
    };
}

/* ---------------- 单个部署场景 ---------------- */
async function runScenario(browser, prefix, label, report) {
    const srv = await startServer(prefix);
    const baseUrl = 'http://127.0.0.1:' + srv.port + (prefix || '');
    const trace = {
        cdpAutoAttach: null, cdpTargets: [], cdpSessions: [], cdpNet: [], cdpErrors: [],
        workers: [], pageErrors: [], pageNetwork: null,
        interceptionHits: [], interceptionErrors: []
    };
    let ctx = null;
    try {
        const prep = await newPage(browser, baseUrl, trace);
        ctx = prep.ctx;
        const page = prep.page;

        // 说明为何不走 browser-level CDP autoAttach（见文件头 §5）
        trace.cdpAutoAttach = 'skipped-by-design: server-side request log is authoritative; puppeteer 24.x manages targets in flatten mode';

        report.scenarios[label] = report.scenarios[label] || {};

        /* ---- ① 负向对照 A：CDP interception 注入 404（team-lead 指定手法） ---- */
        let interceptActive = true;
        const onReq = req => {
            // 关键：拦截撤销后旧回调绝不能再调用 continue/respond，
            // 否则 puppeteer 抛 "Request Interception is not enabled!"。
            if (!interceptActive) return;
            try {
                if (/deep-eval-worker\.js$/.test(req.url())) {
                    trace.interceptionHits.push(req.url());
                    return req.respond({ status: 404, contentType: 'text/plain', body: '404 by QA interception' });
                }
                return req.continue();
            } catch (e) { trace.interceptionErrors.push(e.message); }
        };
        await page.setRequestInterception(true);
        page.on('request', onReq);
        srv.setBlock(true);                    // 双保险：即便 interception 漏掉，服务端也注入
        await page.reload({ waitUntil: 'load' });
        await waitReady(page);
        await sleep(200);

        srv.clear();
        let negResult, negError = null;
        try { negResult = await callRun(page); }
        catch (e) { negError = e.message; }
        const negLog = srv.log.slice();
        report.scenarios[label].negative = {
            channel: 'CDP page.setRequestInterception (req.respond 404)',
            via: negResult && negResult.via,
            error: negError,
            resultShapeOk: !!(negResult && negResult.best && Array.isArray(negResult.ranking) && negResult.ranking.length >= 3),
            rankingLen: negResult && negResult.ranking ? negResult.ranking.length : null,
            injected404SeenByServer: negLog.filter(x => x.tag === 'injected-404').length,
            interceptionHitWorkerUrl: trace.interceptionHits.length,
            interceptionErrors: trace.interceptionErrors,
            workerCreatedInNegative: trace.workers.length,
            note: 'CDP 在网络层之前 respond，请求未到达 QA 静态服务，故服务端窗口为空是预期行为；注入生效证据是 interceptionHits + via=sync',
            negWindow: negLog.map(x => ({ url: x.url, status: x.status, tag: x.tag }))
        };

        /* ---- ② 撤销 CDP 拦截（生命周期：先停用 → 移除监听 → 关闭） ---- */
        await sleep(150);                     // 让 in-flight interception 回调先落地
        interceptActive = false;
        page.off('request', onReq);
        await page.setRequestInterception(false);

        /* ---- ③ 负向对照 B：仅服务端注入真实 HTTP 404，不经过 CDP ---- */
        // 目的：把「服务端注入通道」也实测一遍，避免只靠一条通道下结论；
        // 同时验证真实 HTTP 404（而非 CDP 伪造响应）同样能触发 worker.onerror → runSync。
        await page.reload({ waitUntil: 'load' });   // 清 workerBroken
        await waitReady(page);
        await sleep(200);
        srv.clear();
        let neg2Result, neg2Error = null;
        try { neg2Result = await callRun(page); }
        catch (e) { neg2Error = e.message; }
        const neg2Log = srv.log.slice();
        report.scenarios[label].negativeServer = {
            channel: 'QA static server (real HTTP 404, no interception)',
            via: neg2Result && neg2Result.via,
            error: neg2Error,
            resultShapeOk: !!(neg2Result && neg2Result.best && Array.isArray(neg2Result.ranking) && neg2Result.ranking.length >= 3),
            rankingLen: neg2Result && neg2Result.ranking ? neg2Result.ranking.length : null,
            injected404SeenByServer: neg2Log.filter(x => x.tag === 'injected-404').length,
            window: neg2Log.map(x => ({ url: x.url, status: x.status, tag: x.tag }))
        };

        /* ---- ④ 正常路径：关注入 + 显式 reload 清 workerBroken 单例 ---- */
        srv.setBlock(false);
        await page.reload({ waitUntil: 'load' });   // ★ 显式 reload（team-lead 要求）
        await waitReady(page);
        await sleep(300);
        srv.clear();
        trace.workers.length = 0;             // 只统计正常路径窗口
        trace.pageErrors.length = 0;          // 只统计正常路径窗口

        let posResult, posError = null;
        try { posResult = await callRun(page); }
        catch (e) { posError = e.message; }
        await sleep(400);                     // 等 worker 侧请求全部落盘
        const posLog = srv.log.slice();
        const win = analyseWindow(posLog, prefix);

        report.scenarios[label].positive = {
            via: posResult && posResult.via,
            error: posError,
            resultShapeOk: !!(posResult && posResult.best && Array.isArray(posResult.ranking) && posResult.ranking.length >= 3),
            rankingLen: posResult && posResult.ranking ? posResult.ranking.length : null,
            window: win,
            cdp: {
                autoAttach: trace.cdpAutoAttach,
                pageNetwork: trace.pageNetwork,
                workerCreated: trace.workers,
                cdpTargets: trace.cdpTargets,
                cdpSessionsAttached: trace.cdpSessions,
                cdpNetEvents: trace.cdpNet.length
            },
            pageErrors: trace.pageErrors
        };
    } finally {
        if (ctx) { try { await ctx.close(); } catch (e) {} }
        await srv.close();
    }
}

/* ---------------- ④ 版本源 / 报告数字 / HEAD ---------------- */
function versionChecks(report) {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const pkg = JSON.parse(read('package.json'));
    const man = JSON.parse(read('manifest.webmanifest'));
    const sw = read('sw.js');
    const html = read('index.html');
    const changelog = read('CHANGELOG.md');
    const readme = read('README.md');
    const acc = JSON.parse(read('reports/acceptance.json'));
    const swVer = (sw.match(/const VERSION = '([^']+)'/) || [])[1];
    const htmlVer = (html.match(/id="app-version"[^>]*>v([0-9.]+)</) || [])[1];
    const changelogHas = /## \[2\.8\.1\]/.test(changelog);
    const readmeUnit = (readme.match(/npm test\s+#\s*单元\s*(\d+)\s*项/) || [])[1];
    const readmeE2E = (readme.match(/E2E\s*(\d+)\s*套件\s*(\d+)\s*项/) || []);
    const heads = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
    const status = execFileSync('git', ['status', '--short'], { cwd: ROOT }).toString().trim();
    const engineDiff = execFileSync('git', ['diff', '--stat', 'HEAD', '--', 'js/engine/', 'js/core/game.js'], { cwd: ROOT }).toString().trim();

    // 生产目录里是否还有 "/js/..." 根绝对路径（本次修复要消除的对象）
    const rootAbs = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'js'), { recursive: true })) {
        if (!String(f).endsWith('.js')) continue;
        const rel = 'js/' + String(f).replace(/\\/g, '/');
        const txt = read(rel);
        const hits = txt.match(/(?:src|href|importScripts|new Worker)\s*[=(]?\s*['"`]\/js\//g);
        if (hits) rootAbs.push({ file: rel, hits });
    }
    const htmlRootAbs = (html.match(/(?:src|href)\s*=\s*["']\/js\//g) || []).length;

    report.version = {
        head: heads,
        gitStatus: status || '(空 = 干净；唯一允许项是 QA 脚本 tests/qa/final-2.8.1-audit.js)',
        package: pkg.version,
        manifest: man.version,
        sw: swVer,
        indexBadge: htmlVer,
        changelogHas281: changelogHas,
        acceptance: { verdict: acc.verdict, unitAssertions: acc.unitAssertions, e2e: acc.e2e, problems: acc.problems },
        readme: { unit: readmeUnit, e2eSuites: readmeE2E[1], e2eItems: readmeE2E[2], raw52: readme.split('\n')[51], raw53: readme.split('\n')[52] },
        engineDiff: engineDiff || '(空 = 零 diff)',
        rootAbsoluteJsRefs: rootAbs,
        htmlRootAbsoluteJsRefs: htmlRootAbs,
        allFourAre281: pkg.version === '2.8.1' && man.version === '2.8.1' && swVer === '2.8.1' && htmlVer === '2.8.1',
        numbersConsistent: String(acc.unitAssertions) === readmeUnit && String(acc.e2e.suites) === readmeE2E[1] && String(acc.e2e.total) === readmeE2E[2]
    };
}

/* ---------------- main ---------------- */
(async () => {
    const report = {
        startedAt: new Date().toISOString(),
        fixtures: {
            serverLogAuthoritative: true,
            swIsolated: 'QA 独立静态服务对 /sw.js 返回 404，避免 sw.js cache-first 命中缓存掩盖 Worker importScripts 请求；被测 Worker 逻辑零改动',
            cacheControl: 'no-store, must-revalidate',
            pageCDP: 'Network.enable + setCacheDisabled(true) + setBypassServiceWorker(true)',
            cdpAutoAttach: 'skipped-by-design（见脚本头 §5）',
            note: '产品源码 / 已有测试 / 配置均零改动；唯一新增文件是本 QA 辅助脚本与 .log'
        },
        scenarios: {}, checks: {}, version: null
    };
    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: EDGE,
            headless: 'new',
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        });
        await runScenario(browser, '', 'root', report);
        await runScenario(browser, '/sub/path', 'subpath', report);
    } catch (e) {
        report.fatal = e.stack;
    } finally {
        if (browser) { try { await browser.close(); } catch (e) {} }
    }

    try { versionChecks(report); }
    catch (e) { report.versionError = e.stack; }

    /* ---- 判定（证伪导向：任何一条不满足即 FAIL） ---- */
    const root = report.scenarios.root || {};
    const sub = report.scenarios.subpath || {};
    const rn = root.negative || {}, rp = root.positive || {};
    const sn = sub.negative || {}, sp = sub.positive || {};
    const rn2 = root.negativeServer || {}, sn2 = sub.negativeServer || {};
    const winR = rp.window || {}, winS = sp.window || {};
    const c = {
        '1 负向对照 via!==worker': !!(rn.via && rn.via !== 'worker'),
        '1b 负向对照 via===sync': rn.via === 'sync',
        '1c 负向结果结构正常': rn.resultShapeOk === true,
        '1d CDP 注入 404 确实命中 worker URL': rn.interceptionHitWorkerUrl > 0 && sn.interceptionHitWorkerUrl > 0,
        '1d2 服务端真实 HTTP 404 确实注入': rn2.injected404SeenByServer > 0 && sn2.injected404SeenByServer > 0,
        '1d3 服务端 404 通道也回退非 worker': !!(rn2.via && rn2.via !== 'worker') && !!(sn2.via && sn2.via !== 'worker'),
        '1e 子路径负向 via!==worker': !!(sn.via && sn.via !== 'worker'),
        '2 正常路径 via===worker': rp.via === 'worker',
        '2b 正常结果结构正常': rp.resultShapeOk === true,
        '2c reload 后 worker 被创建': (rp.cdp && rp.cdp.workerCreated && rp.cdp.workerCreated.length) > 0,
        '2d 观测到 >=9 个 worker 侧请求': winR.workerSideRequestCount >= 9,
        '2e 观测到 9 个不同 worker 侧 URL': winR.distinctWorkerSideUrls >= 9,
        '2f worker 侧零 4xx': winR.zero4xx === true,
        '2g via 非常量(负向≠正向)': !!(rn.via && rp.via && rn.via !== rp.via),
        '3 子路径 via===worker': sp.via === 'worker',
        '3b 子路径结果结构正常': sp.resultShapeOk === true,
        '3c 子路径 worker 侧请求带前缀': winS.allUrlsHavePrefix === true,
        '3d 子路径观测到 >=9 个 worker 侧请求': winS.workerSideRequestCount >= 9,
        '3e 子路径观测到 9 个不同 worker 侧 URL': winS.distinctWorkerSideUrls >= 9,
        '3f 子路径 worker 侧零 4xx': winS.zero4xx === true,
        '4 四处版本源均 2.8.1': !!(report.version && report.version.allFourAre281),
        '4b CHANGELOG 含 2.8.1': !!(report.version && report.version.changelogHas281),
        '4c README 与 acceptance 数字一致': !!(report.version && report.version.numbersConsistent),
        '4d 引擎零 diff': !!(report.version && report.version.engineDiff === '(空 = 零 diff)'),
        '4e 生产 js 无 /js/ 根绝对路径': !!(report.version && report.version.rootAbsoluteJsRefs.length === 0 && report.version.htmlRootAbsoluteJsRefs === 0),
        '4f acceptance PASS 且问题 0': !!(report.version && report.version.acceptance.verdict === 'PASS' && report.version.acceptance.problems.length === 0),
        '4g HEAD === 31075fb': !!(report.version && report.version.head === '31075fbcefa1b0c604a82cc1abdabfe830b3f192')
    };
    report.checks = c;
    report.failedChecks = Object.keys(c).filter(k => !c[k]);
    report.verdict = !report.fatal && report.failedChecks.length === 0 ? 'PASS' : 'FAIL';

    const out = JSON.stringify(report, null, 2);
    console.log(out);
    fs.writeFileSync(path.join(__dirname, 'final-2.8.1-audit.log'), out);
    process.exitCode = report.verdict === 'PASS' ? 0 : 1;
})().catch(e => { console.error('FATAL', e.stack); process.exit(2); });
