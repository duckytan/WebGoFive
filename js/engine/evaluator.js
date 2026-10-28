/**
 * 五子棋引擎 —— 局面评估
 *
 * 两层评估：
 *   1. 局面评估 evaluate()：直接读棋盘增量维护的棋型计数，O(1)。
 *   2. 点评估 pointValue()：查「9 格窗口 → 中心点棋型」预计算表，
 *      编码由棋盘增量维护，所以每点只需 4 次查表。
 *
 * 为什么局面评估必须用「棋型计数 + 组合判定」而不是「把所有棋型分数加起来」：
 *   两个活三相加 = 40000，只比一个冲四(50000)小一点；
 *   但双活三是必胜的（对手只能挡一边）。所以组合必须单独判定 ——
 *   这就是 08 章「评估陷阱」第 1 条。
 *
 * @module engine/evaluator
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) {
        require('./constants.js');
        require('./board.js');
    }
    const C = root.GMK.C;
    const Board = root.GMK.Board;
    const {
        SHAPE, SHAPE_COUNT, SHAPE_SCORE, COMBO, POW3,
        SCORE_WIN, SCORE_WIN_THRESHOLD, DEFENSE_WEIGHT,
        EMPTY, BLACK, WHITE, DIRS
    } = C;

    /* ------------------------------------------------------------------ *
     * 1. 单方局面分
     * ------------------------------------------------------------------ */

    /**
     * 计算某一方的局面价值（只看他自己形成的棋型）。
     * @param {Board} b
     * @param {number} p
     * @returns {number}
     */
    function sideScore(b, p) {
        const c = b.shapeCount;
        const base = (p === BLACK ? 0 : 1) * SHAPE_COUNT;

        if (c[base + SHAPE.FIVE] > 0) return SCORE_WIN;

        const openFour = c[base + SHAPE.OPEN_FOUR];
        const four = c[base + SHAPE.FOUR];
        const openThree = c[base + SHAPE.OPEN_THREE];
        const sleepThree = c[base + SHAPE.SLEEP_THREE];
        const openTwo = c[base + SHAPE.OPEN_TWO];
        const sleepTwo = c[base + SHAPE.SLEEP_TWO];

        // —— 必胜组合：无论对手怎么走都挡不住 ——
        //   双活四 / 活四+冲四 / 双冲四，都有两个独立的成五点
        if (openFour >= 2 || (openFour >= 1 && four >= 1) || four >= 2) return COMBO.WINNING;

        // 单项累加值，作为下限
        const sum = openFour * SHAPE_SCORE[SHAPE.OPEN_FOUR]
            + four * SHAPE_SCORE[SHAPE.FOUR]
            + openThree * SHAPE_SCORE[SHAPE.OPEN_THREE]
            + sleepThree * SHAPE_SCORE[SHAPE.SLEEP_THREE]
            + openTwo * SHAPE_SCORE[SHAPE.OPEN_TWO]
            + sleepTwo * SHAPE_SCORE[SHAPE.SLEEP_TWO];

        // —— 近必胜组合：取 max，绝不相加 ——
        if (four >= 1 && openThree >= 1) return Math.max(COMBO.FOUR_THREE, sum);
        if (openThree >= 2) return Math.max(COMBO.DOUBLE_THREE, sum);

        return sum;
    }

    /**
     * 从 p 的视角评估整个局面（negamax 用）。
     *
     * ⚠ 这里有一个必须守住的约束：**evaluate(p) 必须严格等于 -evaluate(opp)**。
     *
     * negamax 的本质是「子节点取负」，它隐含假设评估函数是零和的。
     * 早先的实现写成 `me - op * 1.1`，看着合理，但它不零和：
     *     evaluate(p) + evaluate(opp) = -0.1 × (me + op)
     * 这个偏差**随局面激烈程度变化**（开局约 200，双方各有两个四时约 7000），
     * 于是搜索在不同层数上系统性地偏袒「轮到谁走」，出现典型的奇偶效应 ——
     * 表现为「同一局面深一层结论就翻转」。
     *
     * 所以现在改成零和形式，把「防守权重」交给着法排序去表达
     * （见 search.js 的 _genMoves：对方分按 1.0 计入，不再打折）。
     *
     * @param {Board} b
     * @param {number} p 视角方
     * @returns {number} 正数表示 p 占优
     */
    function evaluate(b, p) {
        const me = sideScore(b, p);
        const op = sideScore(b, p === BLACK ? WHITE : BLACK);

        if (me >= SCORE_WIN) return SCORE_WIN_THRESHOLD;
        if (op >= SCORE_WIN) return -SCORE_WIN_THRESHOLD;

        let v = me - op;
        if (v > SCORE_WIN_THRESHOLD) v = SCORE_WIN_THRESHOLD;
        else if (v < -SCORE_WIN_THRESHOLD) v = -SCORE_WIN_THRESHOLD;
        return v;
    }

    /* ------------------------------------------------------------------ *
     * 2. 中心点棋型表
     *
     * 「以某点为中心、前后各 4 格的 9 格窗口」编码成三进制数：
     *   0 = 空   1 = 己方子（含假设落在中心的这一子）   2 = 非己方
     * 3^9 = 19683 种，全部预计算，得到「在中心落子能形成的最强棋型」。
     * ------------------------------------------------------------------ */

    /** @type {Int8Array} 值 = 棋型编号，-1 表示没有棋型 */
    const CENTER_SHAPE = new Int8Array(19683).fill(-1);

    (function buildCenterTable() {
        const buf = new Uint8Array(11);       // 9 格 + 两端边界
        const out = new Int16Array(SHAPE_COUNT);
        buf[0] = 3;                           // 3 = 边界（与棋盘表示一致）
        buf[10] = 3;

        for (let code = 0; code < 19683; code++) {
            let v = code;
            for (let k = 8; k >= 0; k--) {
                buf[k + 1] = v % 3;
                v = (v / 3) | 0;
            }
            buf[5] = 1;                       // 中心一定是己方子
            out.fill(0);
            CENTER_SHAPE[code] = Board.classifyBuffer(buf, 9, out, 5);
        }
    })();

    /** 中心格在 9 格窗口里的位下标是 4，落子使其 0→1，编码 +POW3[4]=81 */
    const CENTER_BIT = POW3[4];

    /**
     * 在 i 落 p 子，四个方向各自能形成什么棋型。
     * @param {Board} b
     * @param {number} i 填充索引（必须为空点）
     * @param {number} p 行棋方
     * @param {Int8Array} out 长度 4 的输出
     */
    function pointShapes(b, i, p, out) {
        const code = (p === BLACK ? b.codeB : b.codeW);
        const base = i * 4;
        out[0] = CENTER_SHAPE[code[base] + CENTER_BIT];
        out[1] = CENTER_SHAPE[code[base + 1] + CENTER_BIT];
        out[2] = CENTER_SHAPE[code[base + 2] + CENTER_BIT];
        out[3] = CENTER_SHAPE[code[base + 3] + CENTER_BIT];
    }

    /**
     * 点的静态价值：在 i 落 p 子能形成的棋型分数之和。
     * 用于着法排序（越大越先搜）。
     */
    function pointValue(b, i, p) {
        const code = (p === BLACK ? b.codeB : b.codeW);
        const base = i * 4;
        let total = 0;
        let s;
        s = CENTER_SHAPE[code[base] + CENTER_BIT];
        if (s >= 0) total += SHAPE_SCORE[s];
        s = CENTER_SHAPE[code[base + 1] + CENTER_BIT];
        if (s >= 0) total += SHAPE_SCORE[s];
        s = CENTER_SHAPE[code[base + 2] + CENTER_BIT];
        if (s >= 0) total += SHAPE_SCORE[s];
        s = CENTER_SHAPE[code[base + 3] + CENTER_BIT];
        if (s >= 0) total += SHAPE_SCORE[s];
        return total;
    }

    /** 在 i 落 p 子是否直接成五 */
    function isWinningPoint(b, i, p) {
        const code = (p === BLACK ? b.codeB : b.codeW);
        const base = i * 4;
        const F = SHAPE.FIVE;
        return CENTER_SHAPE[code[base] + CENTER_BIT] === F
            || CENTER_SHAPE[code[base + 1] + CENTER_BIT] === F
            || CENTER_SHAPE[code[base + 2] + CENTER_BIT] === F
            || CENTER_SHAPE[code[base + 3] + CENTER_BIT] === F;
    }

    const Evaluator = {
        sideScore, evaluate, pointValue, pointShapes, isWinningPoint, CENTER_SHAPE
    };

    root.GMK.Evaluator = Evaluator;
    if (typeof module !== 'undefined' && module.exports) module.exports = Evaluator;
})();
