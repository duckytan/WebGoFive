/**
 * 五子棋引擎 —— 禁手判定
 *
 * 依据 references/docs/rif-rules.md 第 9.2、9.3 条：
 *
 *   9.2  黑棋在**没有同时成五**的前提下，出现下列情况判白胜：
 *        a) 长连（六子及以上）
 *        b) 四四
 *        c) 三三（9.3 允许的除外）
 *
 * 所以判定顺序是固定的，不能换：
 *   五连 → 长连 → 四四 → 三三
 * 顺序换了的后果很直接：「五连 + 长连」同时出现时会被误判成长连禁手，
 * 而规则明确说五连优先（9.2 的 "without at the same time attaining
 * five in a row"）。
 *
 * 三个最容易写错的地方：
 *
 *   1. 「四」不等于「活四」。冲四也是四。
 *      很多实现只统计活四，于是漏判四四 —— 冲四 + 冲四 也是四四禁手。
 *
 *   2. 同一方向上最多算一个四。活四有两个成五点，但那是**一个**四，
 *      不能数成两个四，否则每个活四都会被判成四四。
 *
 *   3. 「三」必须是活三，而且「补一子成活四」这一手本身不能是禁手。
 *      这就是 9.3 的递归：如果补那一子会形成长连或四四，则这个三不算数；
 *      如果补那一子会形成双三，还要按同样办法继续验下去（9.3 b）。
 *      递归深度必须有上限，否则可能无限展开 —— 这里取 3 层。
 *
 * @module engine/forbidden
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) {
        require('./constants.js');
        require('./board.js');
    }
    const C = root.GMK.C;
    const { EMPTY, BLACK, WHITE, WALL, SIZE, PAD, W, BOARD_LEN, CELLS } = C;
    const STEP = root.GMK.Board.STEP;

    /** 9.3 的递归上限。实战中 2 层就够，3 层已经覆盖所有常见形。 */
    const MAX_DEPTH = 3;

    /* ------------------------------------------------------------------ *
     * 基础几何
     * ------------------------------------------------------------------ */

    /**
     * 从 j 出发，沿 step 找出 p 的连续段两端。
     * @returns {[number, number]} [a, b]，step>0 时 a<=b，step<0 时 a>=b
     */
    function spanThrough(cells, j, step, p) {
        let a = j, b = j;
        while (cells[a - step] === p) a -= step;
        while (cells[b + step] === p) b += step;
        return [a, b];
    }

    /** 连续段长度（step 可正可负，用除法归一） */
    function spanLen(a, b, step) {
        return (b - a) / step + 1;
    }

    /** 连续段是否覆盖 i（i 一定与 a、b 在同一条线上） */
    function spanHas(a, b, i) {
        const lo = a < b ? a : b, hi = a < b ? b : a;
        return i >= lo && i <= hi;
    }

    /* ------------------------------------------------------------------ *
     * 五连 / 长连
     * ------------------------------------------------------------------ */

    /** 以 i 为中心，恰为 5 的方向数 */
    function countFives(cells, i, p) {
        let n = 0;
        for (let d = 0; d < 4; d++) {
            const step = STEP[d];
            const [a, b] = spanThrough(cells, i, step, p);
            if (spanLen(a, b, step) === 5) n++;
        }
        return n;
    }

    /** 是否存在 6 子及以上的方向 */
    function hasOverline(cells, i, p) {
        for (let d = 0; d < 4; d++) {
            const step = STEP[d];
            const [a, b] = spanThrough(cells, i, step, p);
            if (spanLen(a, b, step) >= 6) return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * 四
     * ------------------------------------------------------------------ */

    /**
     * 哪些方向上存在「四」。
     *
     * 四的定义：**再加一子就能成五**。
     * 注意要求「恰好五」而不是「五以上」——
     * XX_XXX 这种填中间会变成六连，不算四。
     *
     * @returns {number} 4 位掩码，第 d 位为 1 表示方向 d 上有四
     */
    function fourMask(cells, i, p) {
        let mask = 0;
        for (let d = 0; d < 4; d++) {
            const step = STEP[d];
            for (let m = -4; m <= 4; m++) {
                if (m === 0) continue;
                const j = i + m * step;
                if (cells[j] !== EMPTY) continue;

                cells[j] = p;
                const [a, b] = spanThrough(cells, j, step, p);
                const len = spanLen(a, b, step);
                const covers = spanHas(a, b, i);
                cells[j] = EMPTY;

                // 必须「五连且包含 i」才算这手棋在方向 d 上做出了四，
                // 否则棋盘另一端一个无关的五连也会被算进来。
                if (len === 5 && covers) { mask |= (1 << d); break; }
            }
        }
        return mask;
    }

    /* ------------------------------------------------------------------ *
     * 三（含 9.3 的递归）
     * ------------------------------------------------------------------ */

    /** 判定「在 j 补一子」这一手本身是否合法（9.3 里的 without ...） */
    function extensionLegal(cells, j, p, depth) {
        cells[j] = p;
        const r = analyzePlaced(cells, j, p, depth);
        cells[j] = EMPTY;

        if (r.five) return true;            // 直接成五，当然是合法的一手
        if (r.overline) return false;       // 会形成长连 → 这个三不算
        if (r.fours >= 2) return false;     // 会形成四四 → 这个三不算
        if (r.threes >= 2) return false;    // 会形成双三 → 这个三不算（9.3 b）
        return true;
    }

    /**
     * 方向 d 上是否存在「由 i 这一手做出来的活三」。
     *
     * 活三的定义：补一子能变成**活四**（四子连续、两端皆空）。
     * 只能变成冲四的不算活三 —— 这正是「眠三不参与三三判定」。
     */
    function canOpenFour(cells, i, p, d, depth) {
        const step = STEP[d];
        for (let m = -4; m <= 4; m++) {
            if (m === 0) continue;
            const j = i + m * step;
            if (cells[j] !== EMPTY) continue;

            cells[j] = p;
            const [a, b] = spanThrough(cells, j, step, p);
            const len = spanLen(a, b, step);
            const covers = spanHas(a, b, i);
            let openFour = false;
            if (len === 4 && covers) {
                // 两端都得是空点；贴边或对方子都只能算冲四
                openFour = cells[a - step] === EMPTY && cells[b + step] === EMPTY;
            }
            cells[j] = EMPTY;

            if (openFour && extensionLegal(cells, j, p, depth)) return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * 汇总
     * ------------------------------------------------------------------ */

    /**
     * 分析「已经落在 i 上的这一手」。
     * 调用前 cells[i] 必须已经是 p。
     *
     * @param {Int8Array} cells
     * @param {number} i
     * @param {number} p
     * @param {number} depth 三三判定的剩余递归层数，0 表示只查长连/四四
     */
    function analyzePlaced(cells, i, p, depth) {
        const fives = countFives(cells, i, p);
        if (fives > 0) {
            // 五连优先：成五就是赢，后面一概不看
            return { five: true, overline: false, fives, fours: 0, threes: 0 };
        }

        if (hasOverline(cells, i, p)) {
            return { five: false, overline: true, fives: 0, fours: 0, threes: 0 };
        }

        const mask = fourMask(cells, i, p);
        let fours = 0;
        for (let d = 0; d < 4; d++) if (mask & (1 << d)) fours++;

        let threes = 0;
        // 已经是四四了就不必再数三 —— 结果一样是禁手，省掉最贵的一段
        if (depth > 0 && fours < 2) {
            for (let d = 0; d < 4; d++) {
                if (canOpenFour(cells, i, p, d, depth - 1)) threes++;
            }
        }

        return { five: false, overline: false, fives: 0, fours, threes };
    }

    /**
     * 判定在 i 落 p 子是否禁手。
     *
     * @param {object} board 引擎 Board
     * @param {number} i 填充索引（必须为空点）
     * @param {number} p 行棋方
     * @param {object} [opts] { strict:true 时对白棋也判定（默认只判黑） }
     * @returns {{forbidden:boolean, type:string|null, five:boolean, fours:number, threes:number}}
     */
    function check(board, i, p, opts) {
        const strict = opts && opts.strict;
        const legal = { forbidden: false, type: null, five: false, fours: 0, threes: 0 };

        if (!strict && p !== BLACK) return legal;      // 白棋没有禁手
        const cells = board.cells;
        if (cells[i] !== EMPTY) return legal;

        cells[i] = p;
        const r = analyzePlaced(cells, i, p, MAX_DEPTH);
        cells[i] = EMPTY;

        if (r.five) return { forbidden: false, type: null, five: true, fours: 0, threes: 0 };
        if (r.overline) return { forbidden: true, type: '长连', five: false, fours: 0, threes: 0 };
        if (r.fours >= 2) return { forbidden: true, type: '四四', five: false, fours: r.fours, threes: r.threes };
        if (r.threes >= 2) return { forbidden: true, type: '三三', five: false, fours: r.fours, threes: r.threes };
        return { forbidden: false, type: null, five: false, fours: r.fours, threes: r.threes };
    }

    /** 布尔快捷方式 */
    function isForbidden(board, i, p, opts) {
        return check(board, i, p, opts).forbidden;
    }

    /* ------------------------------------------------------------------ *
     * 二维数组入口（给 game-core.js 用，它内部是 board[y][x]）
     * ------------------------------------------------------------------ */

    const GRID_CELLS = new Int8Array(BOARD_LEN);

    /** 把 15×15 的二维数组铺成引擎的填充棋盘（只铺盘内，四周留 WALL） */
    function fillFromGrid(grid) {
        GRID_CELLS.fill(WALL);
        for (let y = 0; y < SIZE; y++) {
            const row = grid[y];
            for (let x = 0; x < SIZE; x++) {
                GRID_CELLS[C.idx(x, y)] = row[x];
            }
        }
        return GRID_CELLS;
    }

    /**
     * 直接对二维棋盘判定。
     * @param {number[][]} grid board[y][x]，0=空 1=黑 2=白
     */
    function checkGrid(grid, x, y, p, opts) {
        const strict = opts && opts.strict;
        const legal = { forbidden: false, type: null, five: false, fours: 0, threes: 0 };
        if (!strict && p !== BLACK) return legal;
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return legal;
        if (grid[y][x] !== EMPTY) return legal;

        const cells = fillFromGrid(grid);
        const i = C.idx(x, y);
        cells[i] = p;
        const r = analyzePlaced(cells, i, p, MAX_DEPTH);
        cells[i] = EMPTY;

        if (r.five) return { forbidden: false, type: null, five: true, fours: 0, threes: 0 };
        if (r.overline) return { forbidden: true, type: '长连', five: false, fours: 0, threes: 0 };
        if (r.fours >= 2) return { forbidden: true, type: '四四', five: false, fours: r.fours, threes: r.threes };
        if (r.threes >= 2) return { forbidden: true, type: '三三', five: false, fours: r.fours, threes: r.threes };
        return { forbidden: false, type: null, five: false, fours: r.fours, threes: r.threes };
    }

    const Forbidden = {
        check, isForbidden, checkGrid,
        analyzePlaced, countFives, hasOverline, fourMask, canOpenFour,
        MAX_DEPTH
    };

    root.GMK.Forbidden = Forbidden;
    if (typeof module !== 'undefined' && module.exports) module.exports = Forbidden;
})();
