/**
 * 棋力高级选项层（P2-5）—— HELL 难度的搜索参数透传
 *
 * 位置：App 层（js/app/），只消费 docs/API-CONTRACT.md 公开契约：
 *   EngineAI.getMove(difficulty) / EngineAI.getBestMove(grid, p, opts)
 * 不碰 js/core/game.js 与 js/engine/* 的任何一行。
 *
 * 机制：Game.getAIMove() 只会调 ai.getMove(difficulty)（GomokuAI 契约），
 * 引擎内部按 C.LEVELS[difficulty] 取搜索参数。要让用户在 HELL 下改
 * timeMs / depth / candidates，就注入一层包装 AI：
 *   · 非 HELL 难度（或未自定义参数）→ 原样委托 engine.getMove(difficulty)
 *   · HELL + 自定义参数 → 走公开契约 engine.getBestMove(board2d, p, opts) 透传
 * lastAIInfo 仍由核心从包装层的 getLastInfo() 读取（委托引擎），诊断链路不变。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    /**
     * 参数边界：搜索在 JS 主线程同步执行（PRD §5.3），必须夹住用户输入，
     * 防止把触摸交互卡死。
     */
    const LIMITS = {
        timeMs: { min: 100, max: 10000 },
        depth: { min: 1, max: 24 },
        candidates: { min: 4, max: 64 }
    };

    /** HELL 默认参数（与引擎 C.LEVELS.HELL 同源；引擎缺席时兜底） */
    function defaults() {
        const lv = GMK.C && GMK.C.LEVELS && GMK.C.LEVELS.HELL;
        return {
            timeMs: (lv && lv.timeMs) || 3500,
            depth: (lv && lv.depth) || 20,
            candidates: (lv && lv.candidates) || 24
        };
    }

    /**
     * 清洗用户输入：非数值回退默认、取整、夹到边界。纯函数（单测直接覆盖）。
     * @param {object} [opts] {timeMs, depth, candidates} 允许残缺 / 越界 / 非数值
     * @returns {{timeMs:number, depth:number, candidates:number}}
     */
    function sanitize(opts) {
        const d = defaults();
        opts = opts || {};
        const pick = function (v, def, lim) {
            if (v == null || v === '') v = def; // null/undefined/空串 = 未提供，回退默认
            else {
                v = Number(v);
                if (!isFinite(v)) v = def;
                else v = Math.round(v);
            }
            if (v < lim.min) v = lim.min;
            if (v > lim.max) v = lim.max;
            return v;
        };
        return {
            timeMs: pick(opts.timeMs, d.timeMs, LIMITS.timeMs),
            depth: pick(opts.depth, d.depth, LIMITS.depth),
            candidates: pick(opts.candidates, d.candidates, LIMITS.candidates)
        };
    }

    /** sanitized 是否等于 HELL 默认（相等则不注入 override，行为与引擎默认完全一致） */
    function equalsDefault(s) {
        const d = defaults();
        return !!s && s.timeMs === d.timeMs && s.depth === d.depth && s.candidates === d.candidates;
    }

    /**
     * 造一个满足 GomokuAI 契约（getMove / getLastInfo / sync）的包装 AI。
     * @param {EngineAI} engine 被包装的引擎实例（其 game 字段指向真实 GomokuGame）
     * @param {object} [stateBox] 可选外部参数仓 {override}；不传则闭包自持
     * @returns 包装对象：getMove(difficulty) / getLastInfo() / sync() / setOverride(opts) / override
     */
    function createWrapper(engine, stateBox) {
        const box = stateBox || {};
        return {
            /** 当前生效参数 {timeMs, depth, candidates} | null（null = 引擎默认） */
            get override() { return box.override || null; },
            /** 注入参数（自动 sanitize）；等于 HELL 默认时自动清空，返回生效值 */
            setOverride(opts) {
                if (!opts) { box.override = null; return null; }
                const s = sanitize(opts);
                box.override = equalsDefault(s) ? null : s;
                return box.override;
            },
            getMove(difficulty) {
                const g = engine.game;
                // 终局守卫必须在透传前做：getBestMove 内部会换上 gameStatus='playing'
                // 的临时 game，会绕过引擎自身的终局判断
                if (!g || g.gameStatus === 'finished') return null;
                const ov = box.override;
                if (difficulty !== 'HELL' || !ov) return engine.getMove(difficulty);
                // 公开契约路径：getBestMove 只映射 timeMs / depth / candidates
                return engine.getBestMove(g.getBoardState(), g.currentPlayer, {
                    difficulty: difficulty,
                    timeMs: ov.timeMs,
                    depth: ov.depth,
                    candidates: ov.candidates
                });
            },
            getLastInfo() { return engine.getLastInfo(); },
            sync() { return engine.sync(); }
        };
    }

    const TunableAI = { LIMITS: LIMITS, sanitize: sanitize, equalsDefault: equalsDefault, createWrapper: createWrapper, defaults: defaults };
    GMK.TunableAI = TunableAI;
    if (typeof module !== 'undefined' && module.exports) module.exports = TunableAI;
})();
