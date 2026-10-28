/**
 * 五子棋引擎 —— 搜索内核
 *
 * 组成（对应 07-AI搜索算法.md）：
 *   · Zobrist 双 32 位哈希（JS 没有 64 位整数，用两个 32 位拼，查表时都要匹配）
 *   · 置换表：并行 TypedArray + 开地址寻址 + 深度优先替换
 *   · 迭代加深 + fail-soft alpha-beta + PVS（主变例搜索）
 *   · 着法排序：置换表着法 → 成五 → 挡五 → 己方活四 → 对方活四 → 杀手 → 历史
 *   · 有限静态搜索：只在存在「四」级威胁时延伸，解决水平线效应
 *   · 时间控制：每 1024 个节点查一次时钟，超时抛异常回退到上一层深度
 *
 * @module engine/search
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) {
        require('./constants.js');
        require('./board.js');
        require('./evaluator.js');
    }
    const C = root.GMK.C;
    const Board = root.GMK.Board;
    const Ev = root.GMK.Evaluator;
    const {
        CELLS, EMPTY, BLACK, WHITE, WALL, SHAPE, SHAPE_COUNT, SHAPE_SCORE,
        SCORE_WIN, SCORE_WIN_THRESHOLD, SIZE, PAD, W
    } = C;

    /* ------------------------------------------------------------------ *
     * Zobrist 哈希
     * ------------------------------------------------------------------ */

    const ZLO = new Uint32Array(CELLS * 2);
    const ZHI = new Uint32Array(CELLS * 2);
    (function initZobrist() {
        // 固定种子的 xorshift32：保证每次运行哈希一致，便于复现 bug
        let s = 0x9E3779B9 | 0;
        const next = () => {
            s ^= s << 13; s |= 0;
            s ^= s >>> 17;
            s ^= s << 5; s |= 0;
            return s >>> 0;
        };
        for (let i = 0; i < CELLS * 2; i++) { ZLO[i] = next(); ZHI[i] = next(); }
    })();

    /**
     * 给 Board 打补丁：place / unplace 自动维护 Zobrist。
     * 这样搜索里不用每处手动 XOR，避免「改了棋盘忘了更新哈希」这类经典 bug。
     */
    if (!Board.prototype.__zobristPatched) {
        const _place = Board.prototype.place;
        const _unplace = Board.prototype.unplace;
        const _reset = Board.prototype.reset;

        Board.prototype.place = function (i, p) {
            _place.call(this, i, p);
            const k = i * 2 + (p === WHITE ? 1 : 0);
            this.zlo = (this.zlo ^ ZLO[k]) | 0;
            this.zhi = (this.zhi ^ ZHI[k]) | 0;
        };
        Board.prototype.unplace = function () {
            const i = this.history[this.history.length - 1];
            const p = this.historyPlayer[this.historyPlayer.length - 1];
            const k = i * 2 + (p === WHITE ? 1 : 0);
            this.zlo = (this.zlo ^ ZLO[k]) | 0;
            this.zhi = (this.zhi ^ ZHI[k]) | 0;
            return _unplace.call(this);
        };
        Board.prototype.reset = function () {
            _reset.call(this);
            this.zlo = 0;
            this.zhi = 0;
        };
        Board.prototype.zlo = 0;
        Board.prototype.zhi = 0;
        Board.prototype.__zobristPatched = true;
    }

    /* ------------------------------------------------------------------ *
     * 置换表
     * ------------------------------------------------------------------ */

    const FLAG_NONE = 0, FLAG_EXACT = 1, FLAG_LOWER = 2, FLAG_UPPER = 3;

    class TranspositionTable {
        constructor(bits) {
            const size = 1 << (bits || 18);        // 默认 26 万条 ≈ 4.4 MB
            this.mask = size - 1;
            this.lo = new Uint32Array(size);
            this.hi = new Uint32Array(size);
            this.score = new Int32Array(size);
            this.depth = new Int8Array(size);
            this.flag = new Uint8Array(size);
            this.move = new Int16Array(size);
            this.gen = new Uint8Array(size);
            this.generation = 0;
            this.hits = 0;
            this.probes = 0;
        }

        newSearch() {
            this.generation = (this.generation + 1) & 0xff;
            this.hits = 0;
            this.probes = 0;
        }

        clear() {
            this.lo.fill(0); this.hi.fill(0); this.flag.fill(0);
            this.depth.fill(0); this.gen.fill(0); this.move.fill(0);
        }

        /**
         * 置换表里的 lo/hi 存在 Uint32Array 里（无符号），而 board.zlo/zhi 是
         * `(x ^ y) | 0` 出来的**有符号** 32 位整数。直接 `!==` 比较的话，
         * 只要哈希是负数，同一个值就会被判成两个不同局面：
         *
         *     存进去：this.lo[idx] = -777305067  →  实际读回 3517662229
         *     比较时：3517662229 !== -777305067  →  永远不相等
         *
         * 后果是**只有 zlo 和 zhi 都为正的局面（约 1/4）能被命中**，
         * 其余 3/4 静默失效：probe 恒返回 null、store 把自己当成「别的局面」
         * 从而可能拒绝更新。实测命中率 3.5%，正是 1/4 折损后的结果。
         *
         * 统一在表的边界上做 `>>> 0`，其余代码保持有符号，互不干扰。
         */
        probe(lo, hi, depth, ply) {
            lo = lo >>> 0;
            hi = hi >>> 0;
            const idx = lo & this.mask;
            this.probes++;
            if (this.flag[idx] === FLAG_NONE) return null;
            if (this.lo[idx] !== lo || this.hi[idx] !== hi) return null;
            this.hits++;

            let sc = this.score[idx];
            // 还原 mate 距离：存储时加了 ply，取回时要减掉
            if (sc > SCORE_WIN_THRESHOLD) sc -= ply;
            else if (sc < -SCORE_WIN_THRESHOLD) sc += ply;

            return {
                score: sc,
                depth: this.depth[idx],
                flag: this.flag[idx],
                move: this.move[idx],
                usable: this.depth[idx] >= depth
            };
        }

        /** 只取着法（提 PV 用，不计入命中率统计） */
        getMove(lo, hi) {
            lo = lo >>> 0;
            hi = hi >>> 0;
            const idx = lo & this.mask;
            if (this.flag[idx] === FLAG_NONE) return -1;
            if (this.lo[idx] !== lo || this.hi[idx] !== hi) return -1;
            return this.move[idx];
        }

        store(lo, hi, depth, score, flag, move, ply) {
            lo = lo >>> 0;
            hi = hi >>> 0;
            const idx = lo & this.mask;
            if (this.flag[idx] !== FLAG_NONE) {
                const samePos = (this.lo[idx] === lo && this.hi[idx] === hi);
                // 同局面必覆盖；不同局面则「本次搜索的优先、深者优先」
                if (!samePos && this.gen[idx] === this.generation && this.depth[idx] > depth) return;
            }
            let sc = score;
            if (sc > SCORE_WIN_THRESHOLD) sc += ply;
            else if (sc < -SCORE_WIN_THRESHOLD) sc -= ply;

            this.lo[idx] = lo;
            this.hi[idx] = hi;
            this.score[idx] = sc;
            this.depth[idx] = depth;
            this.flag[idx] = flag;
            this.move[idx] = move;
            this.gen[idx] = this.generation;
        }
    }

    /* ------------------------------------------------------------------ *
     * 搜索
     * ------------------------------------------------------------------ */

    const TIMEOUT = { timeout: true };
    const INF = 1e9;
    const MAX_PLY = 64;
    const MAX_MOVES = 256;

    class Search {
        constructor(opts) {
            opts = opts || {};
            this.tt = new TranspositionTable(opts.ttBits || 18);
            this.rules = opts.rules || 'freestyle';      // freestyle | standard | renju
            this.nodes = 0;
            this.deadline = 0;
            this.startTime = 0;
            this.stopped = false;
            this.candLimit = 20;

            // 杀手着法：每层 2 个
            this.killers = new Int16Array(MAX_PLY * 2).fill(-1);
            // 历史启发：按落点累计
            this.history = new Int32Array(CELLS);

            /**
             * 每个 ply 独立的着法缓冲。
             * 绝不能所有层共用一个数组 —— 父层正在遍历着法列表时，
             * 递归进子层会把它覆盖掉（这是最容易踩且最难查的 bug 之一）。
             */
            this._mvStack = new Array(MAX_PLY);
            this._shapeBuf = new Int8Array(4);

            this.stats = { depth: 0, score: 0, nodes: 0, timeMs: 0, pv: [], ttHitRate: 0 };
            this.rootBest = -1;

            /**
             * 深层收窄候选数（默认开）。
             *
             * 原来每一层都取满 candLimit=20，但越接近叶子，局面越「安静」，
             * 真正需要算的着法越少 —— 剩下的交给静态搜索去延伸四的威胁就够了。
             * 满候选只会让分支因子白白乘满。
             *
             * 实测：关掉时 900ms 只能到 6~7 层，打开后同样时间能多 1~2 层。
             * 保留开关是为了 A/B —— 收窄过头会让引擎看不见远处的防守点，
             * 而这种退化在单步测试里看不出来，只有自对弈胜率会掉。
             */
            this.candSchedule = opts.candSchedule !== false;

            /**
             * 黑棋禁手屏蔽表：banBlack[i] === 1 表示该点黑棋不能下。
             * 由调用方（gomoku-ai.js）在开局前算好，搜索里只做一次数组读取。
             * 之所以放在搜索里而不是在根节点过滤，是因为「被禁的点」
             * 在整棵子树里对黑棋都不合法，只过滤根节点会漏掉深层。
             */
            this.banBlack = null;
        }

        _buffers(ply) {
            let b = this._mvStack[ply];
            if (!b) {
                b = { mv: new Int32Array(MAX_MOVES), sc: new Float64Array(MAX_MOVES) };
                this._mvStack[ply] = b;
            }
            return b;
        }

        /** 按剩余深度收窄候选数：越靠近叶子越窄 */
        _candLimitAt(depth) {
            if (!this.candSchedule) return this.candLimit;
            const base = this.candLimit;
            if (depth >= 5) return base;
            if (depth >= 3) return base - 4 > 10 ? base - 4 : 10;
            const n = (base * 0.45) | 0;
            return n > 8 ? n : 8;
        }

        /* -------------------- 对外入口 -------------------- */

        /**
         * 计算最佳着法。
         * @param {Board} board
         * @param {object} [opts]
         * @param {number} [opts.timeMs=1000]    思考时间上限
         * @param {number} [opts.depth=8]        最大深度
         * @param {number} [opts.candidates=20]  每层候选着法数
         * @returns {{move:number, score:number, depth:number, nodes:number, timeMs:number, pv:number[]}}
         */
        think(board, opts) {
            opts = opts || {};
            const timeMs = opts.timeMs != null ? opts.timeMs : 1000;
            const maxDepth = opts.depth != null ? opts.depth : 8;
            this.candLimit = opts.candidates != null ? opts.candidates : 20;

            this.startTime = Date.now();
            this.deadline = this.startTime + timeMs;
            this.nodes = 0;
            this.stopped = false;
            this.killers.fill(-1);
            this.tt.newSearch();

            // 历史启发做半衰：否则它会在整局对局里无限累积，
            // 到中盘时开局那几个点的历史值已经毫无参考价值，却还压着排序。
            const hist = this.history;
            for (let i = 0; i < CELLS; i++) hist[i] >>= 1;

            const p = opts.side != null ? opts.side : board.sideToMove();

            // 空盘直接下天元，省掉一次搜索
            if (board.stoneCount() === 0) {
                const c = C.idx(7, 7);
                this.stats = { depth: 0, score: 0, nodes: 0, timeMs: 0, pv: [c], ttHitRate: 0 };
                return { move: c, score: 0, depth: 0, nodes: 0, timeMs: 0, pv: [c], ttHitRate: 0 };
            }

            let bestMove = -1;
            let bestScore = 0;
            let reachedDepth = 0;

            /**
             * ⚠ 超时是用**抛异常**跳出递归的，栈上每一层 `board.place()` 都还没
             * 执行到配对的 `board.unplace()`。如果不在这里回滚，棋盘上就会残留
             * 一堆幽灵棋子 —— 之后每一次搜索都建立在错误的局面上，
             * 表现是「引擎突然开始走完全不相关的点」。
             *
             * 这个 bug 极其隐蔽：单步搜索看不出问题，只有连续对局才会暴露，
             * 而且症状看起来像「棋力弱」而不是「状态被污染」。
             * 所以用 finally 兜底，任何异常路径都必须把棋盘还原。
             */
            const baseHistory = board.history.length;

            try {
                for (let d = 1; d <= maxDepth; d++) {
                    this.rootBest = -1;
                    try {
                        const sc = this._root(board, p, d);
                        if (this.rootBest >= 0) {
                            bestMove = this.rootBest;
                            bestScore = sc;
                            reachedDepth = d;
                        }
                        // 已经算出必胜/必败，再深也没意义
                        if (Math.abs(bestScore) > SCORE_WIN_THRESHOLD) break;
                    } catch (e) {
                        if (e !== TIMEOUT) throw e;
                        this.stopped = true;
                        break;
                    }
                    if (Date.now() > this.deadline) break;
                }
            } finally {
                while (board.history.length > baseHistory) board.unplace();
            }

            const timeUsed = Date.now() - this.startTime;

            /**
             * 根局面也要写进置换表。
             *
             * `extractPV()` 是靠「沿置换表一路取最佳着法」来还原主变例的，
             * 而 `_root()` 从来不调 `store()` —— 根局面根本不在表里。
             * 结果就是 extractPV 第一步 `getMove()` 就返回 -1，**PV 恒为空**。
             * 这个 bug 不报错、不影响棋力，只是让所有依赖 PV 的地方
             * （复盘、调试、着法解释）永远拿不到数据，所以一直没被发现。
             */
            if (bestMove >= 0) {
                this.tt.store(board.zlo, board.zhi, reachedDepth, bestScore, FLAG_EXACT, bestMove, 0);
            }

            const pv = bestMove >= 0 ? this.extractPV(board, p, 8) : [];

            this.stats = {
                depth: reachedDepth,
                score: bestScore,
                nodes: this.nodes,
                timeMs: timeUsed,
                pv,
                ttHitRate: this.tt.probes ? this.tt.hits / this.tt.probes : 0
            };

            return {
                move: bestMove >= 0 ? bestMove : this._fallback(board, p),
                score: bestScore,
                depth: reachedDepth,
                nodes: this.nodes,
                timeMs: timeUsed,
                pv,
                ttHitRate: this.stats.ttHitRate
            };
        }

        _fallback(board, p) {
            const mv = this._genMoves(board, p, -1, 0, 1, 0);
            return mv.length ? mv[0] : -1;
        }

        /** 沿置换表把主变例走出来（不改动棋盘最终状态） */
        extractPV(board, p, maxLen) {
            const pv = [];
            const made = [];
            let side = p;
            for (let k = 0; k < maxLen; k++) {
                const m = this.tt.getMove(board.zlo, board.zhi);
                if (m < 0 || board.cells[m] !== EMPTY) break;
                pv.push(m);
                board.place(m, side);
                made.push(m);
                if (board.isFive(m)) break;
                side = C.opp(side);
            }
            for (let k = made.length - 1; k >= 0; k--) board.unplace();
            return pv;
        }

        /* -------------------- 根节点 -------------------- */

        _root(board, p, depth) {
            const moves = this._genMoves(board, p, this.rootBest, 0, Math.max(this.candLimit, 12), 0);
            if (moves.length === 0) return 0;

            let alpha = -INF;
            const beta = INF;
            let best = -INF;

            for (let k = 0; k < moves.length; k++) {
                const m = moves[k];
                board.place(m, p);

                let v;
                if (board.isFive(m)) {
                    v = SCORE_WIN - 1;
                } else if (k === 0) {
                    v = -this._negamax(board, C.opp(p), depth - 1, -beta, -alpha, 1);
                } else {
                    // PVS：先零窗口试探，失败再全窗口重搜
                    v = -this._negamax(board, C.opp(p), depth - 1, -alpha - 1, -alpha, 1);
                    if (v > alpha && v < beta) {
                        v = -this._negamax(board, C.opp(p), depth - 1, -beta, -alpha, 1);
                    }
                }
                board.unplace();

                if (v > best) {
                    best = v;
                    this.rootBest = m;
                    if (v > alpha) alpha = v;
                }
            }
            return best;
        }

        /* -------------------- 主搜索 -------------------- */

        _negamax(board, p, depth, alpha, beta, ply) {
            if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) throw TIMEOUT;

            const lo = board.zlo, hi = board.zhi;

            // 置换表探查
            const tte = this.tt.probe(lo, hi, depth, ply);
            let ttMove = -1;
            if (tte) {
                ttMove = tte.move;
                if (tte.usable) {
                    if (tte.flag === FLAG_EXACT) return tte.score;
                    if (tte.flag === FLAG_LOWER) { if (tte.score > alpha) alpha = tte.score; }
                    else if (tte.flag === FLAG_UPPER) { if (tte.score < beta) beta = tte.score; }
                    if (alpha >= beta) return tte.score;
                }
            }

            if (depth <= 0) return this._quiesce(board, p, alpha, beta, ply, 0);

            const moves = this._genMoves(board, p, ttMove, ply, this._candLimitAt(depth), depth);
            if (moves.length === 0) return 0;             // 棋盘满，和棋

            const alphaOrig = alpha;
            let best = -INF;
            let bestMove = -1;

            for (let k = 0; k < moves.length; k++) {
                const m = moves[k];
                board.place(m, p);

                let v;
                if (board.isFive(m)) {
                    v = SCORE_WIN - ply - 1;
                } else if (k === 0) {
                    v = -this._negamax(board, C.opp(p), depth - 1, -beta, -alpha, ply + 1);
                } else {
                    v = -this._negamax(board, C.opp(p), depth - 1, -alpha - 1, -alpha, ply + 1);
                    if (v > alpha && v < beta) {
                        v = -this._negamax(board, C.opp(p), depth - 1, -beta, -alpha, ply + 1);
                    }
                }
                board.unplace();

                if (v > best) {
                    best = v;
                    bestMove = m;
                    if (v > alpha) {
                        alpha = v;
                        if (alpha >= beta) {
                            // 剪枝：记录杀手 + 历史启发
                            if (m !== this.killers[ply * 2] && m !== this.killers[ply * 2 + 1]) {
                                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                                this.killers[ply * 2] = m;
                            }
                            const h = this.history[m] + depth * depth;
                            this.history[m] = h > 100000 ? 100000 : h;   // 防止溢出、防止历史值压制静态分
                            break;
                        }
                    }
                }
            }

            const flag = best <= alphaOrig ? FLAG_UPPER
                : best >= beta ? FLAG_LOWER
                    : FLAG_EXACT;
            this.tt.store(lo, hi, depth, best, flag, bestMove, ply);
            return best;
        }

        /* -------------------- 静态搜索 -------------------- */

        /**
         * 只在存在「四」级威胁时延伸。
         * 没有四的时候直接返回评估值 —— 这个早退让静止搜索几乎零开销，
         * 同时避免「对手下一步就成五、引擎却以为局面平静」的水平线效应。
         */
        _quiesce(board, p, alpha, beta, ply, qd) {
            if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) throw TIMEOUT;
            const opp = C.opp(p);
            const v0 = Ev.evaluate(board, p);

            if (qd >= 4) return v0;
            const hasFour = board.count(p, SHAPE.FOUR) || board.count(p, SHAPE.OPEN_FOUR)
                || board.count(opp, SHAPE.FOUR) || board.count(opp, SHAPE.OPEN_FOUR);
            if (!hasFour) return v0;

            if (v0 >= beta) return v0;
            if (v0 > alpha) alpha = v0;

            const moves = this._genMoves(board, p, -1, ply, 6, 0);
            let best = v0;
            for (let k = 0; k < moves.length; k++) {
                const m = moves[k];
                board.place(m, p);
                let v;
                if (board.isFive(m)) v = SCORE_WIN - ply - 1;
                else v = -this._quiesce(board, opp, -beta, -alpha, ply + 1, qd + 1);
                board.unplace();
                if (v > best) {
                    best = v;
                    if (v > alpha) {
                        alpha = v;
                        if (alpha >= beta) break;
                    }
                }
            }
            return best;
        }

        /* -------------------- 着法生成与排序 -------------------- */

        /**
         * 生成候选着法并按优先级排序。
         *
         * 排序依据（07 章）：
         *   置换表着法 > 我方成五 > 挡对方成五 > 我方活四/冲四 > 对方活四/冲四
         *   > 杀手着法 > 历史启发 > 静态分值
         *
         * @returns {Int32Array} 填充索引数组（长度为 min(limit, 候选数)）
         */
        _genMoves(board, p, ttMove, ply, limit, depth) {
            const opp = C.opp(p);
            const cells = board.cells;
            const nb = board.neighbor;
            const buf = this._buffers(ply < MAX_PLY ? ply : MAX_PLY - 1);
            const mv = buf.mv, sc = buf.sc;
            let n = 0;

            const k1 = ply < MAX_PLY ? this.killers[ply * 2] : -1;
            const k2 = ply < MAX_PLY ? this.killers[ply * 2 + 1] : -1;
            const hist = this.history;
            const ban = (p === BLACK) ? this.banBlack : null;

            for (let y = PAD; y < PAD + SIZE; y++) {
                const rowBase = y * W;
                for (let x = PAD; x < PAD + SIZE; x++) {
                    const idx = rowBase + x;
                    if (cells[idx] !== EMPTY) continue;
                    if (nb[idx] === 0) continue;              // 距最近棋子 2 格以上，跳过
                    if (ban !== null && ban[idx] === 1) continue;   // 黑棋禁手点

                    let s;
                    if (idx === ttMove) {
                        s = 1e12;
                    } else {
                        const own = Ev.pointValue(board, idx, p);
                        const op = Ev.pointValue(board, idx, opp);
                        // 对方分按 1.0 计入：某个点对对手很关键，通常意味着
                        // 它也是我必须抢的点（挡四、挡活三），排序上不能打折。
                        s = own + op;
                        if (s < 1000) {
                            // 安静着法：用杀手与历史拉开次序
                            if (idx === k1) s += 500;
                            else if (idx === k2) s += 250;
                            const h = hist[idx];
                            s += h < 200 ? h : 200;
                        }
                    }
                    if (n >= MAX_MOVES) break;
                    mv[n] = idx;
                    sc[n] = s;
                    n++;
                }
            }

            if (n === 0) return EMPTY_MOVES;

            // 部分选择排序：只要前 limit 个，不必全排
            const take = limit < n ? limit : n;
            for (let a = 0; a < take; a++) {
                let bi = a;
                for (let b = a + 1; b < n; b++) if (sc[b] > sc[bi]) bi = b;
                if (bi !== a) {
                    const ti = mv[a]; mv[a] = mv[bi]; mv[bi] = ti;
                    const ts = sc[a]; sc[a] = sc[bi]; sc[bi] = ts;
                }
            }
            return mv.subarray(0, take);
        }
    }

    const EMPTY_MOVES = new Int32Array(0);

    root.GMK.Search = Search;
    root.GMK.TranspositionTable = TranspositionTable;
    if (typeof module !== 'undefined' && module.exports) module.exports = Search;
})();
