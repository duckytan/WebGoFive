/**
 * 深度评估调度层 —— 主线程 API
 *
 * 职责：把 Analysis.evaluate 的同步浅搜放进 Worker（见 deep-eval-worker.js），
 * Worker 不可用时优雅回退主线程同步。对 UI 只暴露一个 Promise 接口：
 *
 *   GMK.DeepEval.run(board2d, player, opts) → Promise<{best, ranking, via}>
 *     via: 'worker' | 'sync'   （sync = 回退路径，结果完全一致）
 *
 * 回退时机（全部静默降级，不打扰用户）：
 *   - 环境没有 Worker / 构造失败（file:// 协议下 Chrome 禁 Worker）
 *   - Worker 脚本加载或运行报错（onerror / 消息 ok:false）
 *   - 看门狗超时（timeMs + 5s 无响应；引擎自身受 timeMs 约束，这层只防意外）
 *
 * 回退到同步时用 setTimeout(30) 让「AI 计算中」遮罩先上屏一帧 —— 与旧的
 * 同步实现同一手法，避免「点击后界面冻住但看不到任何反馈」。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    // new Worker() 的相对 URL 基准是「文档 URL」（index.html），不是本脚本自身，
    // 站点部署在子路径时会指错。用 currentScript.src 推导出绝对 URL：不受文档
    // 所在目录、<base> 标签、查询串影响；IIFE 顶层同步执行期间 currentScript 有效。
    // 老环境 / 非浏览器（如 file:// 无 currentScript）退回相对路径兜底。
    const WORKER_URL = (function () {
        try {
            const cs = document.currentScript;
            if (cs && cs.src) return new URL('deep-eval-worker.js', cs.src).href;
        } catch (e) { /* 走下面的兜底 */ }
        return 'js/app/deep-eval-worker.js';
    })();

    let worker = null;        // 惰性创建，复用
    let workerBroken = false; // 一旦证实不可用，本页面生命周期内不再尝试
    let seq = 0;              // 请求自增 id
    const pending = new Map(); // id → { resolve, reject, timer }

    function ensureWorker() {
        if (workerBroken || typeof Worker === 'undefined') return null;
        if (worker) return worker;
        try {
            worker = new Worker(WORKER_URL);
        } catch (e) {
            // file:// 下 new Worker 直接抛 SecurityError
            workerBroken = true;
            worker = null;
            return null;
        }
        worker.onmessage = function (e) {
            const d = e.data || {};
            const p = pending.get(d.id);
            if (!p) return;
            pending.delete(d.id);
            clearTimeout(p.timer);
            if (d.ok) p.resolve(d.res);
            else { workerBroken = true; p.reject(new Error(d.error || 'worker 求值失败')); }
        };
        worker.onerror = function () {
            // 脚本 404 / 语法错 / importScripts 失败都走到这里：降级并在本次拒绝
            workerBroken = true;
            for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('worker 不可用')); }
            pending.clear();
            try { worker.terminate(); } catch (e) { /* ignore */ }
            worker = null;
        };
        return worker;
    }

    /** 同步回退：等一帧让遮罩上屏，再跑 Analysis.evaluate */
    function runSync(board2d, player, opts) {
        return new Promise(function (resolve, reject) {
            setTimeout(function () {
                try {
                    const res = GMK.Analysis.evaluate(board2d, player, opts);
                    res.via = 'sync';
                    resolve(res);
                } catch (e) {
                    reject(e);
                }
            }, 30);
        });
    }

    const DeepEval = {
        /** 是否可能走 Worker（仅作展示用；run() 本身自会回退） */
        workerAvailable() {
            return typeof Worker !== 'undefined' && !workerBroken;
        },

        /**
         * 跑一次深度评估。
         * @param {number[][]} board2d
         * @param {number} player 视角方
         * @param {object} [opts] {timeMs=500, depth=8, candidates=10}
         * @returns {Promise<{best, ranking, via:string}>}
         */
        run(board2d, player, opts) {
            opts = opts || {};
            const w = ensureWorker();
            if (!w) return runSync(board2d, player, opts);

            const id = ++seq;
            const timeMs = opts.timeMs != null ? opts.timeMs : 500;
            return new Promise(function (resolve, reject) {
                const timer = setTimeout(function () {
                    pending.delete(id);
                    // 超时后这个 worker 不可信（正常情况引擎会自己按时返回），
                    // 换一个新的，本次请求走同步回退
                    try { w.terminate(); } catch (e) { /* ignore */ }
                    worker = null;
                    reject(new Error('worker 响应超时'));
                }, timeMs + 5000);
                pending.set(id, { resolve, reject, timer });
                w.postMessage({ id: id, board2d: board2d, player: player, opts: opts });
            }).then(function (res) {
                if (res && typeof res === 'object') res.via = 'worker';
                return res;
            }).catch(function () {
                // 任何 worker 路径的失败都退回同步实现，保证调用方永远拿得到结果
                return runSync(board2d, player, opts);
            });
        }
    };

    GMK.DeepEval = DeepEval;
    if (typeof module !== 'undefined' && module.exports) module.exports = DeepEval;
})();
