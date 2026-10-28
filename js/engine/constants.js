/**
 * 五子棋引擎 —— 常量与评分表
 *
 * 设计依据：docs/gomoku-knowledge/08-AI评估函数与棋型.md
 *
 * 棋盘坐标约定（与 game-core.js 一致）：
 *   x = 列 0..14，y = 行 0..14，原点在左上角
 *   内部使用「填充索引」：idx = (y + PAD) * W + (x + PAD)
 *   PAD = 4 保证任意方向扫描 ±4 格都不越界，省掉所有边界判断
 *
 * @module engine/constants
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    root.GMK = root.GMK || {};

    /** 棋盘边长（路数） */
    const SIZE = 15;
    /** 四周填充层数。取 4 是因为最长棋型窗口是 9 格（左右各 4） */
    const PAD = 4;
    /** 填充后的行宽 */
    const W = SIZE + PAD * 2;          // 23
    /** 填充后的格子总数 */
    const CELLS = W * W;               // 529
    /**
     * 实际分配的数组长度 = CELLS + 尾部保护带。
     *
     * 为什么需要保护带：一维数组里沿副对角方向走会「越过末尾」。
     * 例如 (18,18) 的索引是 528，沿 dy=-1 方向 +4 格会到 616，超出 529。
     * 保护带全部填 WALL，这样越界读到的也是「非空」，语义正确且不会返回 undefined。
     */
    const BOARD_LEN = CELLS + 128;

    /** 格子状态 */
    const EMPTY = 0;
    const BLACK = 1;
    const WHITE = 2;
    /** 边界（不可落子）。用 3 而不是 -1，这样「非我方」判定统一写成 !== player */
    const WALL = 3;

    /** 四个方向：横、竖、主对角、副对角 */
    const DIRS = [
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 }
    ];

    /** 棋型枚举 */
    const SHAPE = {
        FIVE: 0,
        OPEN_FOUR: 1,
        FOUR: 2,
        OPEN_THREE: 3,
        SLEEP_THREE: 4,
        OPEN_TWO: 5,
        SLEEP_TWO: 6
    };
    const SHAPE_COUNT = 7;

    /**
     * 单棋型基础分。
     *
     * 调参依据（08 章「评分表调参规则」）：
     *   冲四 : 活三 应在 2.5~3 : 1  —— 这里 50000 / 20000 = 2.5
     *   活三 : 眠三 应 >= 10 : 1    —— 这里 20000 / 1500 = 13.3
     * 这两个比值是「会不会下棋」的分水岭：
     *   冲四给太低 → 该冲不冲，被对手先成四；
     *   活三给太低 → 只顾做四不顾做三，永远慢一步。
     */
    // 用 Int32Array 而不是普通数组：热路径上要按动态下标取值，
    // 普通数组在这个场景会退化成慢路径，实测差 3~5 倍
    const SHAPE_SCORE = Int32Array.from([
        10000000,   // FIVE
        500000,     // OPEN_FOUR   活四：两个成五点，必死
        50000,      // FOUR        冲四/嵌四：一个成五点
        20000,      // OPEN_THREE  活三
        1500,       // SLEEP_THREE 眠三
        1200,       // OPEN_TWO    活二
        150         // SLEEP_TWO   眠二
    ]);

    /**
     * 复合棋型奖励。
     *
     * 为什么必须单独列表而「不能把单棋型分数相加」：
     *   两个活三相加 = 40000，看起来只比一个冲四(50000)小一点；
     *   但实战中双活三基本等于必胜——对手只能挡一边，另一边直接成活四。
     *   所以双活三的真实价值约等于一个冲四甚至更高，必须给 200000。
     * 这正是 08 章列的「评估陷阱」第 1 条。
     */
    const COMBO = {
        /** 双活四 / 活四+冲四 / 双冲四：都是必胜 */
        WINNING: 9000000,
        /** 四三：冲四 + 活三，也是必胜 */
        FOUR_THREE: 400000,
        /** 双活三：接近必胜 */
        DOUBLE_THREE: 200000
    };

    /** 评估函数的攻防权重：己方分 - 对方分 × DEFENSE_WEIGHT */
    const DEFENSE_WEIGHT = 1.1;

    /** 必胜/必败分数，用于搜索里做截断 */
    const SCORE_WIN = 10000000;
    /** 搜索时认为「已经赢了」的阈值 */
    const SCORE_WIN_THRESHOLD = 5000000;

    /**
     * 三进制位权：POW3[k] = 3^(8-k)。
     * 9 格窗口按 k=0..8 编码成 Σ v_k·POW3[k]，值域 [0, 19682]。
     * 中心格（k=4）的位权是 81 —— 这一点被用来做「假设落子」的快速求值：
     * 中心当前一定是空（值 0），落子后变 1，编码直接 +81。
     */
    const POW3 = new Int32Array(9);
    POW3[8] = 1;
    for (let i = 7; i >= 0; i--) POW3[i] = POW3[i + 1] * 3;

    /**
     * 难度配置。
     *
     * noise 是「失误率」（千分比）：只有 EASY 才有。
     * 早先 NORMAL 也给了 30（3%），实测这是致命的 ——
     * 一局 20 步的棋有 45% 概率至少犯一次错，而且它会在
     * 「对方已经做出活四」这种要命的位置上随手下一手无关的棋。
     * 难度差异应该来自搜索深度，而不是随机送分。
     *
     * depth 是**上限**，真正的限制是 timeMs（迭代加深跑到超时为止）。
     * 早先 NORMAL 的 depth 写 4，结果 800ms 只用了 30ms 就收工 ——
     * 4 层在五子棋里看不到「做三 → 成活四 → 成五」这条三手计划，
     * 表现为对局里一直被动挡棋。现在把上限抬高，让时间成为唯一的瓶颈。
     */
    const LEVELS = {
        EASY:   { depth: 3,  timeMs: 250,  candidates: 12, useKill: false, noise: 120 },
        NORMAL: { depth: 8,  timeMs: 900,  candidates: 16, useKill: true,  noise: 0 },
        HARD:   { depth: 12, timeMs: 1800, candidates: 20, useKill: true,  noise: 0 },
        HELL:   { depth: 20, timeMs: 3500, candidates: 24, useKill: true,  noise: 0 }
    };

    const C = {
        SIZE, PAD, W, CELLS, BOARD_LEN,
        EMPTY, BLACK, WHITE, WALL,
        DIRS, SHAPE, SHAPE_COUNT,
        SHAPE_SCORE, COMBO,
        DEFENSE_WEIGHT, SCORE_WIN, SCORE_WIN_THRESHOLD, POW3,
        LEVELS,

        /** 棋盘坐标 → 填充索引 */
        idx(x, y) { return (y + PAD) * W + (x + PAD); },
        /** 填充索引 → 棋盘坐标 */
        xOf(i) { return (i % W) - PAD; },
        yOf(i) { return ((i / W) | 0) - PAD; },
        /** 索引是否落在真实棋盘内 */
        inBoard(i) {
            const x = (i % W) - PAD;
            const y = ((i / W) | 0) - PAD;
            return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
        },
        /** 对手 */
        opp(p) { return p === BLACK ? WHITE : BLACK; }
    };

    root.GMK.C = C;
    if (typeof module !== 'undefined' && module.exports) module.exports = C;
})();
