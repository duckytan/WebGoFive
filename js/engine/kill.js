/**
 * 五子棋引擎 —— 算杀（VCF）
 *
 * VCF = Victory by Continuous Fours，连续冲四取胜。
 *
 * 为什么它比「加深一层搜索」有用得多：
 *   正常搜索的分支因子约 20，多搜 2 层要 400 倍节点；
 *   而冲四是**强制着法** —— 对手只有一个合法应手（挡住成五点），
 *   所以 VCF 树的分支因子约等于 1，深 15 层也才几十个节点。
 *   换句话说：VCF 把「20 层」的成本压到「20 个节点」。
 *
 * 注意 VCF 只考虑冲四，不考虑活三，所以它证明的胜利是**完备**的
 * （只要返回必胜，就一定必胜）；而 VCT（含活三）搜索空间大得多，
 * 不做完整实现。
 *
 * @module engine/kill
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
    const Ev = root.GMK.Evaluator;
    const { EMPTY, BLACK, WHITE, SHAPE, SIZE, PAD, W } = C;

    /**
     * 找出「在 i 落 p 子之后，所有能补成五的空点」。
     *
     * 这些点就是对手的必应点：
     *   0 个 → 这步棋没形成四；
     *   1 个 → 对手只能挡这一点（冲四）；
     *   ≥2 个 → 对手挡不住（活四 / 双四），已经赢了。
     *
     * @param {object} board
     * @param {number} i 刚落子的位置
     * @param {number} p 行棋方
     * @param {Int32Array} out 输出缓冲（至少 8 长）
     * @returns {number} 五个点数（已去重）
     */
    function fivePoints(board, i, p, out) {
        const cells = board.cells;
        const STEP = root.GMK.Board.STEP;
        let n = 0;

        for (let d = 0; d < 4; d++) {
            const step = STEP[d];
            for (let m = -4; m <= 4; m++) {
                if (m === 0) continue;
                const j = i + m * step;
                if (cells[j] !== EMPTY) continue;
                if (!Ev.isWinningPoint(board, j, p)) continue;

                let dup = false;
                for (let t = 0; t < n; t++) if (out[t] === j) { dup = true; break; }
                if (!dup && n < 8) out[n++] = j;
            }
        }
        return n;
    }

    /**
     * 收集所有「能形成冲四或活四」的着法，按威胁强度排序。
     * @returns {Int32Array}
     */
    function fourMoves(board, p, limit) {
        const cells = board.cells;
        const nb = board.neighbor;
        const shapeBuf = new Int8Array(4);
        const mv = [];
        const pri = [];

        for (let y = PAD; y < PAD + SIZE; y++) {
            const rowBase = y * W;
            for (let x = PAD; x < PAD + SIZE; x++) {
                const idx = rowBase + x;
                if (cells[idx] !== EMPTY) continue;
                if (nb[idx] === 0) continue;

                Ev.pointShapes(board, idx, p, shapeBuf);
                let best = -1;
                let five = false;
                for (let d = 0; d < 4; d++) {
                    const s = shapeBuf[d];
                    if (s < 0) continue;
                    if (s === SHAPE.FIVE) five = true;
                    if (best < 0 || s < best) best = s;
                }
                if (five) { mv.push(idx); pri.push(1e9); continue; }
                if (best === SHAPE.OPEN_FOUR) { mv.push(idx); pri.push(1e6); continue; }
                if (best === SHAPE.FOUR) { mv.push(idx); pri.push(1e5); }
            }
        }

        // 按优先级降序（插入排序，候选数很少）
        for (let a = 1; a < mv.length; a++) {
            const m = mv[a], pv = pri[a];
            let b = a - 1;
            while (b >= 0 && pri[b] < pv) { mv[b + 1] = mv[b]; pri[b + 1] = pri[b]; b--; }
            mv[b + 1] = m; pri[b + 1] = pv;
        }
        return Int32Array.from(mv.slice(0, limit || 24));
    }

    /** 对方是否已经有「四」级威胁（此时不该盲目进攻，必须先处理） */
    function underThreat(board, opp) {
        return board.count(opp, SHAPE.FOUR) > 0 || board.count(opp, SHAPE.OPEN_FOUR) > 0;
    }

    /**
     * VCF 搜索。
     *
     * @param {object} board
     * @param {number} p 进攻方
     * @param {number} [maxDepth=12] 最多连续冲几次
     * @param {object} [stats] 可选统计对象
     * @returns {number} 必胜的首着（填充索引），找不到返回 -1
     */
    function vcf(board, p, maxDepth, stats) {
        maxDepth = maxDepth || 12;
        if (stats) { stats.nodes = 0; stats.depth = 0; }

        const opp = C.opp(p);
        const buf = new Int32Array(8);

        // 自己已经被对手的四威胁住 → 先防守，不进攻
        if (underThreat(board, opp)) return -1;

        function search(depth) {
            if (stats) stats.nodes++;
            if (depth <= 0) return -1;

            const moves = fourMoves(board, p, 24);
            for (let k = 0; k < moves.length; k++) {
                const m = moves[k];
                board.place(m, p);

                // 直接成五
                if (board.isFive(m)) {
                    board.unplace();
                    if (stats) stats.depth = maxDepth - depth + 1;
                    return m;
                }

                const nFive = fivePoints(board, m, p, buf);
                if (nFive === 0) { board.unplace(); continue; }   // 没形成四，跳过

                if (nFive >= 2) {
                    // 活四 / 双四：对手只能挡一个，下一手必成五
                    board.unplace();
                    if (stats) stats.depth = maxDepth - depth + 1;
                    return m;
                }

                // 冲四：对手唯一应手
                const block = buf[0];
                board.place(block, opp);

                // 对手这一挡如果自己形成了四，我们就必须回头防守，这条线作废
                let sub = -1;
                if (!underThreat(board, opp) || board.count(p, SHAPE.FIVE) > 0) {
                    sub = search(depth - 1);
                }

                board.unplace();   // 撤对手的挡
                board.unplace();   // 撤自己的四

                if (sub >= 0) {
                    if (stats) stats.depth = Math.max(stats.depth, maxDepth - depth + 1);
                    return m;
                }
            }
            return -1;
        }

        return search(maxDepth);
    }

    const Kill = { vcf, fivePoints, fourMoves, underThreat };

    root.GMK.Kill = Kill;
    if (typeof module !== 'undefined' && module.exports) module.exports = Kill;
})();
