'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { stopServer } = require('../harness');

/**
 * v2.9.0：关闭 QA 观察项 O-3 ——「SW 已激活且缓存命中时，Worker 路径是否可用」。
 *
 * 做法：等 SW 激活且缓存灌满 → 先在线跑一次深度评估（建立 Worker 基线）→
 * **把静态服务器真正下线**（比 CDP 离线仿真更硬：SW 的 fetch 不经过页面网络栈，
 * 页面级 offline 对 SW 内部 fetch 无效）→ 再点深度评估。
 *
 * 通过标准：via === 'worker' —— Worker 脚本与 importScripts 全部由 SW 缓存喂给，
 * 离线深度评估完整可用。若 via === 'sync'（静默降级），说明缓存没喂上 Worker，
 * O-3 的风险即为真，本套件失败。
 *
 * 注意：本套件会关掉 harness 的服务器，必须排在 run.js 的最后。
 */
async function run(t, { page }) {
    // ── 等 SW 激活 + 缓存灌满（与 08-pwa 同款轮询，窗口放宽到 20s/15s）──
    const swActive = await page.evaluate(() => new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
            navigator.serviceWorker.getRegistration().then((r) => {
                if (r && r.active) return resolve(true);
                if (Date.now() - started > 20000) return resolve(false);
                setTimeout(poll, 200);
            }).catch(() => resolve(false));
        };
        poll();
    }));
    t.eq(swActive, true, 'SW 已激活');
    if (!swActive) return;

    // 在线基线：深度评估走 Worker
    await page.evaluate(() => { document.getElementById('btn-deep-eval').click(); });
    const online = await page.waitForFunction(
        () => window.demo._lastDeepEval && window.demo._lastDeepEval._seq >= 1,
        { timeout: 20000 }
    ).then(() => true).catch(() => false);
    t.eq(online, true, '在线基线：深度评估出结果');
    if (online) {
        const via = await page.evaluate(() => window.demo._lastDeepEval.via);
        t.eq(via, 'worker', '在线时走 Worker 路径', 'via=' + via);
    }
    const seq1 = await page.evaluate(() => window.demo._lastDeepEval._seq);

    // ── 服务器下线（真断网）──
    stopServer();
    await sleep(300);

    // 离线再评估：SW 缓存必须喂饱 Worker 脚本与全部 importScripts
    await page.evaluate(() => { document.getElementById('btn-deep-eval').click(); });
    const offline = await page.waitForFunction(
        (s1) => window.demo._lastDeepEval && window.demo._lastDeepEval._seq > s1,
        { timeout: 30000 }, seq1
    ).then(() => true).catch(() => false);
    t.eq(offline, true, '断网后深度评估仍出结果（SW 缓存兜底）');
    if (offline) {
        const r = await page.evaluate(() => ({
            via: window.demo._lastDeepEval.via,
            best: document.getElementById('ai-best-move').textContent
        }));
        // O-3 的最终裁决：离线时也必须是 Worker 路径（缓存喂饱），而非静默降级
        t.eq(r.via, 'worker', '断网时 Worker 路径由 SW 缓存喂给（O-3 关闭）', 'via=' + r.via);
        t.ok(r.best && r.best !== '—', '离线评估结果已上屏', r.best);
    }
}

module.exports = { run };
