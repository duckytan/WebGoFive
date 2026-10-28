/**
 * AI 分析层 —— 形势优势条 / 威胁点扫描 / 手动深度评估
 *
 * 位置：App 层（js/app/），只读消费引擎公开 API：
 *   GMK.EngineAI / GMK.Evaluator / GMK.C / GMK.Kill
 * 不碰 js/core/game.js 与 js/engine/* 的任何一行。
 *
 * 数据契约（见 docs/AI-ENHANCE-DESIGN.md §2.1）：
 *   Analysis.advantage(board2d, player)        → {side, score, depth}
 *   Analysis.threatPoint(board2d, opponent)   → Array<{x, y, score}>
 *   Analysis.evaluate(board2d, player, opts)  → {best, ranking}
 *   Analysis.scanOpponentThreat(board2d, opp) → {x, y} | null
 *
 * 共享约定（设计文档 §6）：
 *   - 引擎返回的 pv / move 都是「填充索引」（C.xOf / C.yOf 翻译）
 *   - Ev.pointValue(board, i, p)：正=好、负=坏、0=中性；±50000 视为「强」
 *   - 优势条：score > 50000 黑胜 / < -50000 白胜 / 中间均势
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    /** 「强」阈值：超出即视为一方必胜级别 */
    const STRONG = 50000;
    /** 威胁扫描时，候选空点与最近棋子的最大曼哈顿距离 */
    const NEAR_LIMIT = 2;
    /** 单回合最多检查的候选点数（性能保护，设计文档 §7） */
    const SCAN_MAX = 30;

    /* ------------------------------------------------------------------ *
     * 内部工具
     * ------------------------------------------------------------------ */

    /**
     * 把 board2d 装入一个新的引擎 Board（评估/威胁扫描共用）。
     * 引擎 Board 的 loadFrom2D 会增量维护棋型编码，供 Ev.* 查表。
     * @param {number[][]} board2d
     * @returns {Board}
     */
    function toEngineBoard(board2d) {
        const b = new GMK.Board();
        b.loadFrom2D(board2d);
        return b;
    }

    /**
     * 收集「附近有空点」的候选填充索引：距最近棋子 ≤ NEAR_LIMIT 的空点。
     * 开局（无子）时只给天元。
     * @param {Board} eng
     * @returns {number[]}
     */
    function nearbyCandidates(eng) {
        const C = GMK.C;
        const cells = eng.cells, nb = eng.neighbor;
        const out = [];
        for (let i = 0; i < C.CELLS; i++) {
            if (!C.inBoard(i)) continue;
            if (cells[i] !== C.EMPTY) continue;
            if (nb[i] > 0) out.push(i);
        }
        if (out.length === 0) out.push(C.idx(7, 7)); // 开局天元
        return out;
    }

    /** 填充索引 → {x, y} */
    function coordOf(i) {
        const C = GMK.C;
        return { x: C.xOf(i), y: C.yOf(i) };
    }

    /**
     * 用「一次性」的独立 EngineAI 跑浅搜，不污染游戏注入的 AI 实例。
     * EngineAI.getBestMove 内部保存/恢复了 this.game，但为避免
     * 与 game.lastAIInfo 互相干扰，分析层统一自建临时实例。
     *
     * @param {number[][]} board2d
     * @param {number} player 行棋方（视角）
     * @param {object} cfg {timeMs, depth, candidates}
     *        注：EngineAI.getBestMove 只映射 timeMs/depth/candidates，
     *        不支持 useKill 等其它键（见 gomoku-ai.js getBestMove），
     *        故此处不透传额外字段。
     * @returns {{move:number, info:object}|null}
     */
    function quickSearch(board2d, player, cfg) {
        const C = GMK.C;
        const EngineAI = GMK.EngineAI;
        if (!EngineAI) return null;
        const fakeGame = { board: board2d, currentPlayer: player, gameStatus: 'playing' };
        const ai = new EngineAI(fakeGame);
        ai.getBestMove(board2d, player, {
            difficulty: 'NORMAL',
            timeMs: cfg.timeMs != null ? cfg.timeMs : 500,
            depth: cfg.depth != null ? cfg.depth : 8,
            candidates: cfg.candidates != null ? cfg.candidates : 10
        });
        const info = ai.getLastInfo();
        if (!info || info.move < 0 || !C.inBoard(info.move)) {
            return { move: -1, info: info || null };
        }
        return { move: info.move, info: info };
    }

    /* ------------------------------------------------------------------ *
     * 公开方法
     * ------------------------------------------------------------------ */

    const Analysis = {
        /** 当前视角方（1=黑 / 2=白）对手 */
        opp: function (player) { return GMK.C.opp(player); },

        /**
         * 形势评估条数据（浅搜 200ms，避免卡 UI）。
         * score 以「视角方 player」为基准：
         *   > STRONG   该方必胜级 → 视角为白时换算成黑领先
         *   展示统一换算到黑棋视角：黑 > 0 领先 / 白 > 0 领先 / 0 均势
         *
         * @param {number[][]} board2d
         * @param {number} [player] 视角方；不传取「当前行棋方」
         * @returns {{side:'black'|'white'|'equal', score:number, depth:number}}
         */
        advantage(board2d, player) {
            const C = GMK.C;
            if (player == null) player = C.BLACK; // 无行棋方信息时默认黑视角
            const r = quickSearch(board2d, player, {
                timeMs: 200, depth: 4, candidates: 8
            });
            const score = r && r.info ? r.info.score : 0;
            // score 是 player 视角：player=黑 时正=黑领先；player=白 时正=白领先
            const blackView = (player === C.BLACK) ? score : -score;
            let side = 'equal';
            if (blackView > STRONG) side = 'black';
            else if (blackView < -STRONG) side = 'white';
            return {
                side: side,
                score: blackView,
                depth: r && r.info ? r.info.depth : 0
            };
        },

        /**
         * 单点威胁（opponent 能否在此一步成五）。
         * 遍历附近空点，命中 Ev.isWinningPoint 者按 Ev.pointValue 打分。
         *
         * @param {number[][]} board2d
         * @param {number} opponent 对手方（谁在威胁成五）
         * @param {number} [limit] 最多返回几条（默认 3）
         * @returns {Array<{x:number, y:number, score:number}>}
         */
        threatPoint(board2d, opponent, limit) {
            limit = limit != null ? limit : 3;
            const C = GMK.C;
            const Ev = GMK.Evaluator;
            if (!Ev) return [];
            const eng = toEngineBoard(board2d);
            // P0 修复：候选必须「先按 pointValue 预排序、再取 top-N」。
            // 旧实现按填充索引行序 slice(0, SCAN_MAX)，中/下半盘的成五点
            // （行序靠后）会被截断漏掉（活四放低行时 threatPoint 恒空）。
            // 成五点的 pointValue 含 FIVE 形状分（10^7 量级），必居榜首。
            const cands = nearbyCandidates(eng)
                .map(function (i) { return { i: i, v: Ev.pointValue(eng, i, opponent) }; })
                .sort(function (a, b) { return b.v - a.v; })
                .slice(0, SCAN_MAX);
            const hits = [];
            for (let k = 0; k < cands.length; k++) {
                const i = cands[k].i;
                if (Ev.isWinningPoint(eng, i, opponent)) {
                    const v = cands[k].v;
                    const score = (v >= 1000000) ? 1000000 : (v > 0 ? v : STRONG); // 成五点必强
                    hits.push({ x: C.xOf(i), y: C.yOf(i), score: score });
                }
            }
            hits.sort(function (a, b) { return b.score - a.score; });
            return hits.slice(0, limit);
        },

        /**
         * 手动深度评估：浅搜拿最佳变例 + pointValue 排序候选。
         * 对每个候选调 getBestMove 会重搜全树，故按设计文档 §3 T1
         * 改为「一次浅搜 + Ev.pointValue 排序」。
         *
         * @param {number[][]} board2d
         * @param {number} player 视角方
         * @param {object} [opts] {timeMs=500, depth=8, candidates=10}
         * @returns {{best:object, ranking:Array}}
         */
        evaluate(board2d, player, opts) {
            opts = opts || {};
            const C = GMK.C;
            const Ev = GMK.Evaluator;
            const timeMs = opts.timeMs != null ? opts.timeMs : 500;
            const depth = opts.depth != null ? opts.depth : 8;
            const candLimit = opts.candidates != null ? opts.candidates : 10;

            const r = quickSearch(board2d, player, {
                timeMs: timeMs, depth: depth, candidates: candLimit
            });
            const info = r && r.info ? r.info : null;

            // 主要变例：把 pv 索引数组翻译成 {x, y}
            let pv = [];
            if (info && Array.isArray(info.pv)) {
                pv = info.pv.slice(0, 8).map(coordOf);
            }

            // ranking：引擎 pv 起点 + 候选按 pointValue 排序
            // 契约说明：source 字段只出现引擎合法取值 {search, vcf, blunder}；
            // pointValue 排序得到的条目不附带 source（避免把静态估价误标成引擎来源）。
            const eng = toEngineBoard(board2d);
            const cands = nearbyCandidates(eng);
            const seen = {};
            const ranking = [];
            const pushRank = function (i, sourceOverride) {
                if (seen[i]) return;
                seen[i] = true;
                const v = Ev ? Ev.pointValue(eng, i, player) : 0;
                const entry = {
                    x: C.xOf(i), y: C.yOf(i),
                    score: v,
                    pv: pv
                };
                if (sourceOverride != null) entry.source = sourceOverride;
                ranking.push(entry);
            };
            // 引擎给出的最佳点优先（source 取引擎真实来源）
            if (r && r.move >= 0 && info) pushRank(r.move, info.source);
            // 其余候选按 pointValue 从高到低补（不标 source）
            const rest = cands.filter(function (i) { return i !== r.move; })
                .map(function (i) { return { i: i, v: Ev ? Ev.pointValue(eng, i, player) : 0 }; })
                .sort(function (a, b) { return b.v - a.v; });
            for (let k = 0; k < rest.length && ranking.length < candLimit; k++) {
                pushRank(rest[k].i, null);
            }

            const best = (r && r.move >= 0 && info) ? {
                x: C.xOf(r.move), y: C.yOf(r.move),
                score: info.score,
                depth: info.depth,
                nodes: info.nodes,
                timeMs: info.timeMs,
                pv: pv
            } : { x: -1, y: -1, score: 0, depth: 0, nodes: 0, timeMs: 0, pv: pv };

            return { best: best, ranking: ranking, source: info ? info.source : 'search' };
        },

        /**
         * 对手最危险点（即将成五点）。无威胁时返回 null。
         * @param {number[][]} board2d
         * @param {number} opponent
         * @returns {{x:number, y:number}|null}
         */
        scanOpponentThreat(board2d, opponent) {
            const hits = this.threatPoint(board2d, opponent, 1);
            return hits.length ? hits[0] : null;
        },

        /**
         * 开局定式推荐（P2-6）：开局窗口（盘面子数 < 4）内给当前行棋方推荐点。
         * 候选 = 近子空点（空盘退化为天元），按 Ev.pointValue 打分取最高，
         * 同分时更靠中心者优先（中心性 = 到天元的曼哈顿距离取负）。
         * 与 P0 最优提示共用渲染路径（App 层拿结果走 renderer 的 hint 通道）。
         *
         * @param {number[][]} board2d
         * @param {number} player 行棋方
         * @param {object} [opts] {window=4} 开局窗口（盘面子数上限）
         * @returns {{x:number, y:number, score:number, stones:number}|null} 超窗返回 null
         */
        openingRecommendation(board2d, player, opts) {
            const C = GMK.C;
            const Ev = GMK.Evaluator;
            if (!C || !Ev) return null;
            opts = opts || {};
            const win = opts.window != null ? opts.window : 4;
            let stones = 0;
            for (let y = 0; y < board2d.length; y++) {
                const row = board2d[y];
                for (let x = 0; x < row.length; x++) {
                    if (row[x] !== C.EMPTY) stones++;
                }
            }
            if (stones >= win) return null;
            const eng = toEngineBoard(board2d);
            const cands = nearbyCandidates(eng);
            const cx = (C.SIZE - 1) / 2, cy = (C.SIZE - 1) / 2;
            let best = null;
            for (let k = 0; k < cands.length; k++) {
                const i = cands[k];
                const v = Ev.pointValue(eng, i, player);
                const cent = -(Math.abs(C.xOf(i) - cx) + Math.abs(C.yOf(i) - cy));
                if (!best || v > best.v || (v === best.v && cent > best.c)) {
                    best = { i: i, v: v, c: cent };
                }
            }
            if (!best) return null;
            return { x: C.xOf(best.i), y: C.yOf(best.i), score: best.v, stones: stones };
        }
    };

    GMK.Analysis = Analysis;
    if (typeof module !== 'undefined' && module.exports) module.exports = Analysis;
})();
