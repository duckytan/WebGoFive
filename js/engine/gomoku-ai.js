/**
 * 五子棋引擎 —— 对局接入层
 *
 * 这一层只做一件事：把引擎的「填充索引 + 引擎棋盘」翻译成
 * game-core.js 认识的「{x, y} + 二维数组」，并把各种必胜/必挡的
 * 短路判断排在搜索前面。
 *
 * 为什么短路判断要放在搜索之前，而不是指望搜索自己发现：
 *   · 成五 / 挡五只有一步，搜索也能找到，但要多花几十毫秒；
 *   · VCF 是「深 15 层也只要几十个节点」的强制着法，
 *     用主搜索去跑同样深度要 20^15 个节点 —— 根本跑不到。
 *     所以 VCF 必须单独先跑一遍，这是棋力差距最明显的一处。
 *
 * @module engine/gomoku-ai
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) {
        require('./constants.js');
        require('./board.js');
        require('./evaluator.js');
        require('./search.js');
        require('./kill.js');
        require('./forbidden.js');
    }
    const C = root.GMK.C;
    const Board = root.GMK.Board;
    const Search = root.GMK.Search;
    const Ev = root.GMK.Evaluator;
    const Kill = root.GMK.Kill;
    const Forbidden = root.GMK.Forbidden;

    const { EMPTY, BLACK, WHITE, SIZE } = C;

    /** 项目里的难度名 → 引擎难度名 */
    const DIFF_MAP = {
        BEGINNER: 'EASY',
        EASY: 'EASY',
        NORMAL: 'NORMAL',
        HARD: 'HARD',
        HELL: 'HELL'
    };

    class EngineAI {
        /**
         * @param {object} game GomokuGame 实例（需要 board / currentPlayer 两个字段）
         * @param {object} [opts] { ttBits, vcfDepth }
         */
        constructor(game, opts) {
            opts = opts || {};
            this.game = game;
            this.board = new Board();
            this.search = new Search({ ttBits: opts.ttBits || 18 });
            this.ban = new Int8Array(C.CELLS);
            this.info = null;

            this.name = 'GMK-Engine';
            this.version = '1.0.0';
        }

        /* ---------------- 与 game-core 同步 ---------------- */

        /** 把 game.board（二维）搬进引擎棋盘 */
        sync() {
            this.board.loadFrom2D(this.game.board);
            return this.board;
        }

        /**
         * 计算黑棋的禁手屏蔽表。
         * 白棋没有禁手，直接全 0 返回。
         */
        computeBan(p) {
            const ban = this.ban;
            ban.fill(0);
            if (p !== BLACK) return ban;

            const b = this.board;
            const cells = b.cells;
            const nb = b.neighbor;

            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const i = C.idx(x, y);
                    if (cells[i] !== EMPTY) continue;
                    if (nb[i] === 0) continue;           // 离所有棋子都超过 2 格，不可能是禁手
                    if (Forbidden.isForbidden(b, i, BLACK)) ban[i] = 1;
                }
            }
            return ban;
        }

        /* ---------------- 短路判断 ---------------- */

        /**
         * 找「落这一手就成五」的点。
         * @param {number} p 行棋方
         * @param {Int8Array} ban 黑棋禁手表（白棋时忽略）
         * @returns {number} 填充索引，没有则 -1
         */
        findFive(p, ban) {
            const b = this.board;
            const cells = b.cells;
            const nb = b.neighbor;
            const checkBan = (p === BLACK && ban);

            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const i = C.idx(x, y);
                    if (cells[i] !== EMPTY) continue;
                    if (nb[i] === 0) continue;
                    if (checkBan && ban[i] === 1) continue;
                    if (Ev.isWinningPoint(b, i, p)) return i;
                }
            }
            return -1;
        }

        /** 兜底：随便找一个合法空点（优先靠近已有棋子） */
        findAnyLegal(p, ban) {
            const b = this.board;
            const cells = b.cells;
            const nb = b.neighbor;
            const checkBan = (p === BLACK && ban);
            let fallback = -1;

            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const i = C.idx(x, y);
                    if (cells[i] !== EMPTY) continue;
                    if (checkBan && ban[i] === 1) continue;
                    if (nb[i] > 0) return i;
                    if (fallback < 0) fallback = i;
                }
            }
            return fallback;
        }

        /* ---------------- 对外主入口 ---------------- */

        /**
         * 计算一步棋，返回 {x, y}，与 AdvancedAI.getMove 的契约一致。
         * 没有可下点时返回 null。
         *
         * @param {string} difficulty
         * @param {object} [override] 内部用：{ timeMs, depth, candidates } 覆盖难度配置
         */
        getMove(difficulty, override) {
            const g = this.game;
            if (!g || g.gameStatus === 'finished') return null;

            const p = g.currentPlayer;
            const level = DIFF_MAP[difficulty] || 'NORMAL';
            const base = C.LEVELS[level];
            const cfg = override ? Object.assign({}, base, override) : base;
            const t0 = Date.now();

            this.sync();
            const ban = this.computeBan(p);
            this.search.banBlack = ban;

            const info = {
                player: p,
                difficulty,
                level,
                source: '',
                move: -1,
                score: 0,
                depth: 0,
                nodes: 0,
                vcf: -1,
                timeMs: 0
            };

            // 兜底回滚：任何一步出错（尤其是超时抛异常）都不能让棋盘留下残局
            const baseStones = this.board.stoneCount();
            try {
                return this._decide(p, cfg, ban, info, t0);
            } finally {
                while (this.board.stoneCount() > baseStones) this.board.unplace();
            }
        }

        /** getMove 的实际决策流程，抽出来是为了让上面的回滚能包住所有 return */
        _decide(p, cfg, ban, info, t0) {
            // ① 自己能成五 —— 直接赢
            let m = this.findFive(p, ban);
            if (m >= 0) return this._finish(m, 'win', info, t0);

            // ② 对手能成五 —— 必须挡
            m = this.findFive(C.opp(p), ban);
            if (m >= 0) return this._finish(m, 'block', info, t0);

            // ③ 算杀：连续冲四取胜
            if (cfg.useKill) {
                const v = Kill.vcf(this.board, p, cfg.vcfDepth || 12);
                info.vcf = v;
                if (v >= 0 && !(p === BLACK && ban[v] === 1)) {
                    return this._finish(v, 'vcf', info, t0);
                }
            }

            // ④ 主搜索
            const res = this.search.think(this.board, {
                timeMs: cfg.timeMs,
                depth: cfg.depth,
                candidates: cfg.candidates,
                side: p
            });
            info.score = res.score;
            info.depth = res.depth;
            info.nodes = res.nodes;
            info.ttHitRate = res.ttHitRate;
            info.pv = res.pv;

            m = res.move;

            // ⑤ 新手难度：按 noise 比例故意走一步「不算差但也不最好」的棋
            if (cfg.noise > 0 && Math.random() * 1000 < cfg.noise) {
                const bad = this._randomLegal(p, ban);
                if (bad >= 0) { m = bad; info.source = 'blunder'; }
            }

            if (!info.source) info.source = 'search';
            return this._finish(m, info.source, info, t0);
        }

        _randomLegal(p, ban) {
            const b = this.board, cells = b.cells, nb = b.neighbor;
            const checkBan = (p === BLACK && ban);
            const pool = [];
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const i = C.idx(x, y);
                    if (cells[i] !== EMPTY) continue;
                    if (nb[i] === 0) continue;
                    if (checkBan && ban[i] === 1) continue;
                    pool.push(i);
                }
            }
            if (pool.length === 0) return -1;
            return pool[(Math.random() * pool.length) | 0];
        }

        /** 收尾：兜底校验 + 打包返回 */
        _finish(m, source, info, t0) {
            const p = info.player;
            const ban = this.ban;
            const cells = this.board.cells;

            // 万无一失的兜底：越界 / 已占 / 禁手 一律换点
            if (m < 0 || !C.inBoard(m) || cells[m] !== EMPTY
                || (p === BLACK && ban[m] === 1)) {
                m = this.findAnyLegal(p, ban);
            }

            info.move = m;
            info.source = source;
            info.timeMs = Date.now() - t0;
            this.info = info;

            if (m < 0) return null;
            return { x: C.xOf(m), y: C.yOf(m) };
        }

        /* ---------------- 供测试 / 自对弈使用 ---------------- */

        /**
         * 直接对二维棋盘算一步（不依赖 GomokuGame）。
         * @param {number[][]} grid board[y][x]
         * @param {number} p 行棋方
         * @param {object} [opts] { difficulty, timeMs, depth, candidates }
         * @returns {{x:number, y:number}|null}
         */
        getBestMove(grid, p, opts) {
            opts = opts || {};
            const saved = this.game;
            this.game = { board: grid, currentPlayer: p, gameStatus: 'playing' };
            try {
                const override = {};
                let hasOverride = false;
                if (opts.timeMs != null) { override.timeMs = opts.timeMs; hasOverride = true; }
                if (opts.depth != null) { override.depth = opts.depth; hasOverride = true; }
                if (opts.candidates != null) { override.candidates = opts.candidates; hasOverride = true; }
                return this.getMove(opts.difficulty || 'NORMAL', hasOverride ? override : null);
            } finally {
                this.game = saved;
            }
        }

        /** 诊断信息 */
        getLastInfo() { return this.info; }
    }

    root.GMK.EngineAI = EngineAI;
    if (typeof module !== 'undefined' && module.exports) module.exports = EngineAI;
})();
