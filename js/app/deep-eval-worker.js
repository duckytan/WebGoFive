/**
 * 深度评估 Worker 入口
 *
 * 为什么拆 Worker：深度评估是同步浅搜（Analysis.evaluate），HELL 参数下可到
 * 数百毫秒甚至更久，主线程跑会把落子 / 渲染全部冻住（PRD Q1：P2 做 Worker 化）。
 *
 * 复用策略：引擎 7 文件 + js/app/analysis.js 都是「挂到全局 GMK」的 IIFE，
 * 在 Worker 全局作用域里 importScripts 之后行为与主线程完全一致 ——
 * 评估逻辑零拷贝，主线程与 Worker 共用同一份 Analysis.evaluate。
 *
 * 注意：importScripts 的相对路径以 Worker 自身 URL 为基准，故引擎文件用
 * ../engine/、同目录的 analysis.js 直接写文件名 —— 与部署路径无关，站点放在
 * 域名根或任意子路径都能正确加载。本文件不进 index.html 的 script 标签
 * （loadorder 测试因此不会碰它），由 js/app/deep-eval.js 通过 new Worker() 加载，
 * sw.js PRECACHE 负责离线可用。
 */
'use strict';

importScripts(
    '../engine/constants.js',
    '../engine/board.js',
    '../engine/evaluator.js',
    '../engine/search.js',
    '../engine/kill.js',
    '../engine/forbidden.js',
    '../engine/gomoku-ai.js',
    'analysis.js'
);

self.onmessage = function (e) {
    const data = e.data || {};
    const id = data.id;
    try {
        const res = self.GMK.Analysis.evaluate(data.board2d, data.player, data.opts);
        self.postMessage({ id: id, ok: true, res: res });
    } catch (err) {
        self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
    }
};
