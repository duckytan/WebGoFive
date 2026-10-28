/**
 * 五子棋引擎 —— 棋盘表示与棋型识别
 *
 * 关键设计（对应 10-AI工程实现与优化.md）：
 *
 *   1. 一维 Int8Array + 四周 4 层填充 + 尾部保护带。
 *      所有扫描 ±4 格都不越界，整条搜索路径上没有任何 bounds check。
 *
 *   2. 72 条「可能成五」的线（15 行 + 15 列 + 21 主对角 + 21 副对角）。
 *      落一子只影响其中 4 条线，所以棋型统计增量维护 —— 这是相对
 *      「每次评估扫全盘」最大的性能来源。
 *
 *   3. 棋型识别「锚定在己方子上」，用「数连续段 + 断点检查」判定，
 *      不用模式串逐个匹配。理由见 classifyLineDual 注释。
 *
 *   4. 一次扫描同时统计黑白双方。缓冲区里 0=空 1=黑 2=白 3=墙，
 *      判定逻辑只用到 `=== 0` 和 `=== 颜色`，所以天然对双方对称，
 *      没必要按视角重建缓冲区再扫一遍。
 *
 *   5. 落子 / 撤销的所有偏移量都预计算成表，热路径上没有乘法和函数调用。
 *
 * @module engine/board
 */

(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) require('./constants.js');
    const C = root.GMK.C;

    const {
        SIZE, W, CELLS, BOARD_LEN, PAD,
        EMPTY, BLACK, WHITE, WALL, DIRS, SHAPE, SHAPE_COUNT, POW3
    } = C;

    /* ------------------------------------------------------------------ *
     * 预计算
     * ------------------------------------------------------------------ */

    /** 4 个方向在填充索引上的步长 */
    const STEP = [
        DIRS[0].dy * W + DIRS[0].dx,
        DIRS[1].dy * W + DIRS[1].dx,
        DIRS[2].dy * W + DIRS[2].dx,
        DIRS[3].dy * W + DIRS[3].dx
    ];

    /** 每条线按顺序存放填充索引 */
    const LINES = [];
    /** 每个格子 × 4 方向 → 所属线编号（-1 表示该格不在棋盘内） */
    const CELL_LINE = new Int16Array(CELLS * 4).fill(-1);

    (function buildLines() {
        for (let d = 0; d < 4; d++) {
            const { dx, dy } = DIRS[d];
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    // 只从「线的起点」出发：沿反方向再退一格就出界
                    const px = x - dx, py = y - dy;
                    if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) continue;

                    const cells = [];
                    let cx = x, cy = y;
                    while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE) {
                        cells.push(C.idx(cx, cy));
                        cx += dx; cy += dy;
                    }
                    if (cells.length < 5) continue;      // 长度不足 5 永远成不了五

                    const id = LINES.length;
                    const arr = Int16Array.from(cells);
                    LINES.push(arr);
                    for (let k = 0; k < arr.length; k++) CELL_LINE[arr[k] * 4 + d] = id;
                }
            }
        }
    })();

    /** 邻域 2 格内的 25 个偏移量 */
    const NEI25 = (function () {
        const a = new Int16Array(25);
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) a[n++] = dy * W + dx;
        }
        return a;
    })();

    /**
     * 点视角编码的偏移量：DELTA4[d][t] 表示「从落子点走到窗口第 t 格」的索引增量。
     * t=0..8 对应窗口偏移 -4..+4，t=4 就是落子点自己。
     * 位权是 POW3[t]。
     */
    const DELTA4 = (function () {
        const a = [];
        for (let d = 0; d < 4; d++) {
            const arr = new Int16Array(9);
            for (let t = 0; t < 9; t++) arr[t] = (4 - t) * STEP[d];
            a.push(arr);
        }
        return a;
    })();

    /* ------------------------------------------------------------------ *
     * 棋型识别
     *
     * 做法：沿一条线单向扫描，遇到棋子就数「连续段长度」，再检查
     * 「本段 + 一个空 + 下一段」是否构成断点棋型（11011 / 1101 之类）。
     * 取两者中更强的那个，然后整段消耗掉。
     *
     * 为什么不用模式串表：早期版本用 11 条模式串逐个匹配，每颗子都要
     * 跑一遍 11 次比较，一条线 15 格就是 165 次。改成数连续段后
     * 每个格子只读一次，实测快 4 倍以上 —— 而这个函数在 place() 里
     * 被调用 4 次/子，是整条搜索链路最热的点。
     *
     * 为什么必须以棋子起锚、不能用「上下文写进模式串」的写法：
     * 以空位起锚的短模式会抢先命中。实测：一行是 "....XXX....."，
     * 扫到第 2 个空位时 '00011'（眠二）先匹配，把三颗子的第一颗吃掉，
     * 结果三子被识别成眠二 —— 表现到棋盘上就是「AI 看不见自己的活三」。
     * ------------------------------------------------------------------ */

    const K_FIVE = 0;        // 五连
    const K_FOUR = 1;        // 连续 4 子：两端空=活四，否则=冲四
    const K_FOUR_GAP = 2;    // 断点冲四 11011 / 10111 / 11101，恒为冲四
    const K_THREE = 3;       // 连续或跳 3 子
    const K_TWO = 4;         // 2 子
    const K_ONE = 5;         // 单子

    /**
     * 对一条线同时统计双方棋型。
     *
     * @param {Uint8Array} buf  长度 n+2，值域 {0=空, 1=黑, 2=白, 3=墙}；
     *                          buf[0] 与 buf[n+1] 必须是 3
     * @param {number} n        真实格数
     * @param {Int16Array} outA 黑方计数输出（长度 7，调用方清零）
     * @param {Int16Array} outB 白方计数输出（长度 7，调用方清零）
     * @param {number} [center] 若给出（buf 下标），返回覆盖它的最强棋型
     * @param {number} [centerColor=1] center 归属方
     * @returns {number} 覆盖 center 的最强棋型编号，无则 -1
     */
    function classifyLineDual(buf, n, outA, outB, center, centerColor) {
        const total = n + 2;
        const hasCenter = center !== undefined && center >= 0;
        let best = -1;
        let k = 1;

        while (k <= n) {
            const v = buf[k];
            if (v === 0 || v === 3) { k++; continue; }

            // 1) 数连续段
            let run = 1;
            while (buf[k + run] === v) run++;

            let len = run;
            let kind;
            if (run >= 5) kind = K_FIVE;
            else if (run === 4) kind = K_FOUR;
            else if (run === 3) kind = K_THREE;
            else if (run === 2) kind = K_TWO;
            else kind = K_ONE;

            // 2) 断点棋型：本段 + 一个空 + 下一段（下一段必须同色）
            if (kind !== K_FIVE && buf[k + run] === 0 && buf[k + run + 1] === v) {
                let r2 = 1;
                while (buf[k + run + 1 + r2] === v) r2++;
                const stones = run + r2;
                const glen = run + 1 + r2;
                if (glen > len) {
                    if (stones >= 4) { kind = K_FOUR_GAP; len = glen; }
                    else if (stones === 3) { kind = K_THREE; len = glen; }
                    else if (stones === 2) { kind = K_TWO; len = glen; }
                }
            }

            const out = (v === BLACK) ? outA : outB;
            let shape = -1;

            // 3) 定级
            if (kind === K_FIVE) {
                out[SHAPE.FIVE]++;
                shape = SHAPE.FIVE;
                if (hasCenter && v === centerColor && center >= k && center < k + len) {
                    best = SHAPE.FIVE;
                }
                k += len;                     // 整段吃掉，长连不会拆成「五连 + 活二」
                continue;
            }

            const pre = buf[k - 1];                                    // k >= 1，安全
            const post = (k + len < total) ? buf[k + len] : 3;

            switch (kind) {
                case K_FOUR:
                    // 两头都被堵死的四没有成五点，是**死四**，一文不值。
                    // 不排除它会导致什么后果：实测黑棋曾靠两个死四被评成
                    // 「双四必胜」（900 万分），于是整局都以为赢定了，
                    // 实际上那两条线根本补不成五。
                    if (pre !== 0 && post !== 0) break;
                    if (pre === 0 && post === 0) { out[SHAPE.OPEN_FOUR]++; shape = SHAPE.OPEN_FOUR; }
                    else { out[SHAPE.FOUR]++; shape = SHAPE.FOUR; }
                    break;
                case K_FOUR_GAP:
                    // 断点四的成五点就是那个空，恒为真四，永远不是活四
                    out[SHAPE.FOUR]++; shape = SHAPE.FOUR;
                    break;
                case K_THREE: {
                    // 活三 = 两端空，且再落一子真能成活四。
                    // 连续三子要看外侧是否还有空（否则落子后是「堵死的四」）；
                    // 跳三（len=4，如 11_1 / 1_11）只要两端空，落中间就是活四。
                    if (pre !== 0 && post !== 0) break;            // 死三，不计
                    const openEnds = (pre === 0 && post === 0);
                    const canOpen = len === 4
                        || (k >= 2 && buf[k - 2] === 0)
                        || (k + len + 1 < total && buf[k + len + 1] === 0);
                    if (openEnds && canOpen) { out[SHAPE.OPEN_THREE]++; shape = SHAPE.OPEN_THREE; }
                    else { out[SHAPE.SLEEP_THREE]++; shape = SHAPE.SLEEP_THREE; }
                    break;
                }
                case K_TWO:
                    if (pre !== 0 && post !== 0) break;            // 死二，不计
                    if (pre === 0 && post === 0) { out[SHAPE.OPEN_TWO]++; shape = SHAPE.OPEN_TWO; }
                    else { out[SHAPE.SLEEP_TWO]++; shape = SHAPE.SLEEP_TWO; }
                    break;
                default:
                    break;                    // K_ONE：不计数
            }

            if (hasCenter && shape >= 0 && v === centerColor
                && center >= k && center < k + len) {
                if (best < 0 || shape < best) best = shape;
            }
            k += len;
        }
        return best;
    }

    /**
     * 单方视角的包装（预计算中心点棋型表时用）。
     * buf 值域 {0=空, 1=己方, 2=非己方}，把「己方」当作黑方即可。
     */
    function classifyBuffer(buf, n, out, center) {
        return classifyLineDual(buf, n, out, SCRATCH_OUT, center, BLACK);
    }
    const SCRATCH_OUT = new Int16Array(SHAPE_COUNT);

    /* ------------------------------------------------------------------ *
     * Board
     * ------------------------------------------------------------------ */

    class Board {
        constructor() {
            /** @type {Int8Array} 填充后的棋盘，值 ∈ {0,1,2,3}；尾部多留保护带 */
            this.cells = new Int8Array(BOARD_LEN).fill(EMPTY);

            // 填充层全部写 WALL，之后永远不需要再判边界
            for (let y = 0; y < W; y++) {
                for (let x = 0; x < W; x++) {
                    if (x < PAD || x >= PAD + SIZE || y < PAD || y >= PAD + SIZE) {
                        this.cells[y * W + x] = WALL;
                    }
                }
            }
            // 尾部保护带（见 constants.js 里 BOARD_LEN 的说明）
            for (let i = CELLS; i < BOARD_LEN; i++) this.cells[i] = WALL;

            /** 落子栈（填充索引） */
            this.history = [];
            /** 每步落子的行棋方 */
            this.historyPlayer = [];

            /** 每条线 × 每方 × 每种棋型的计数 */
            this.lineShapes = new Int16Array(2 * LINES.length * SHAPE_COUNT);
            /** 全盘棋型总计数：[playerIdx * 7 + shape] */
            this.shapeCount = new Int32Array(2 * SHAPE_COUNT);

            /** 每个格子的邻域标记：附近 2 格内有几颗子，用于生成候选点 */
            this.neighbor = new Int16Array(CELLS);

            /**
             * 「点视角」三进制编码缓存，按 [格子 × 方向] 索引。
             * codeB = 以黑方视角编码（黑子记 1，其余记 2）
             * codeW = 以白方视角编码
             *
             * 维护它的理由：着法排序要对几十个候选点各算一次「落了这子能成什么棋型」。
             * 现场算编码是 4 方向 × 9 次乘加 = 36 次运算/点；
             * 增量维护则是每落一子只更新 36 个格子 × 2 视角，
             * 折到每个候选点上不足 1 次运算 —— 差一个数量级。
             */
            this.codeB = new Int32Array(CELLS * 4);
            this.codeW = new Int32Array(CELLS * 4);
            this._initCodes();

            this._buf = new Uint8Array(SIZE + 2);
            this._outB = new Int16Array(SHAPE_COUNT);
            this._outW = new Int16Array(SHAPE_COUNT);
        }

        /** 把编码表恢复成空盘状态（棋盘外记 2，盘内空点记 0） */
        _initCodes() {
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const base = C.idx(x, y) * 4;
                    for (let d = 0; d < 4; d++) {
                        const { dx, dy } = DIRS[d];
                        let code = 0;
                        for (let k = 0; k < 9; k++) {
                            const nx = x + (k - 4) * dx;
                            const ny = y + (k - 4) * dy;
                            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) code += 2 * POW3[k];
                        }
                        this.codeB[base + d] = code;
                        this.codeW[base + d] = code;
                    }
                }
            }
        }

        /* ---------------- 基础查询 ---------------- */

        get(x, y) { return this.cells[C.idx(x, y)]; }
        isEmpty(x, y) { return this.cells[C.idx(x, y)] === EMPTY; }
        stoneCount() { return this.history.length; }
        lastMove() { return this.history.length ? this.history[this.history.length - 1] : -1; }
        sideToMove() {
            return this.history.length === 0 ? BLACK : C.opp(this.historyPlayer[this.history.length - 1]);
        }

        /** 从 game-core.js 的二维数组同步过来 */
        loadFrom2D(grid) {
            this.reset();
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const v = grid[y][x];
                    if (v === BLACK || v === WHITE) this.place(C.idx(x, y), v);
                }
            }
        }

        /** 导出成 game-core.js 的二维数组 */
        to2D() {
            const g = [];
            for (let y = 0; y < SIZE; y++) {
                const row = new Array(SIZE);
                for (let x = 0; x < SIZE; x++) row[x] = this.cells[C.idx(x, y)];
                g.push(row);
            }
            return g;
        }

        reset() {
            for (let i = 0; i < CELLS; i++) {
                if (this.cells[i] !== WALL) this.cells[i] = EMPTY;
            }
            this.history.length = 0;
            this.historyPlayer.length = 0;
            this.lineShapes.fill(0);
            this.shapeCount.fill(0);
            this.neighbor.fill(0);
            this._initCodes();
        }

        /* ---------------- 落子 / 撤销 ---------------- */

        place(i, p) {
            const cells = this.cells;
            cells[i] = p;
            this.history.push(i);
            this.historyPlayer.push(p);

            // 邻域标记（25 格）
            const nb = this.neighbor;
            for (let t = 0; t < 25; t++) {
                const idx = i + NEI25[t];
                if (cells[idx] !== WALL) nb[idx]++;
            }

            // 点视角编码（36 格 × 2 视角）
            const vB = (p === BLACK) ? 1 : 2;
            const vW = (p === BLACK) ? 2 : 1;
            const codeB = this.codeB, codeW = this.codeW;
            for (let d = 0; d < 4; d++) {
                const del = DELTA4[d];
                for (let t = 0; t < 9; t++) {
                    const idx = i + del[t];
                    if (cells[idx] === WALL) continue;
                    const base = idx * 4 + d;
                    const w = POW3[t];
                    codeB[base] += vB * w;
                    codeW[base] += vW * w;
                }
            }

            // 只重算这一子经过的 4 条线
            const cl = CELL_LINE;
            for (let d = 0; d < 4; d++) {
                const L = cl[i * 4 + d];
                if (L >= 0) this._refreshLine(L);
            }
        }

        /** 撤销最后一步（与 place 严格配对） */
        unplace() {
            const i = this.history.pop();
            const p = this.historyPlayer.pop();
            const cells = this.cells;
            cells[i] = EMPTY;

            const nb = this.neighbor;
            for (let t = 0; t < 25; t++) {
                const idx = i + NEI25[t];
                if (cells[idx] !== WALL) nb[idx]--;
            }

            const vB = (p === BLACK) ? 1 : 2;
            const vW = (p === BLACK) ? 2 : 1;
            const codeB = this.codeB, codeW = this.codeW;
            for (let d = 0; d < 4; d++) {
                const del = DELTA4[d];
                for (let t = 0; t < 9; t++) {
                    const idx = i + del[t];
                    if (cells[idx] === WALL) continue;
                    const base = idx * 4 + d;
                    const w = POW3[t];
                    codeB[base] -= vB * w;
                    codeW[base] -= vW * w;
                }
            }

            const cl = CELL_LINE;
            for (let d = 0; d < 4; d++) {
                const L = cl[i * 4 + d];
                if (L >= 0) this._refreshLine(L);
            }
            return i;
        }

        /* ---------------- 棋型统计 ---------------- */

        _refreshLine(L) {
            const cells = LINES[L];
            const n = cells.length;
            const board = this.cells;
            const buf = this._buf;

            buf[0] = 3;
            buf[n + 1] = 3;
            for (let k = 0; k < n; k++) buf[k + 1] = board[cells[k]];

            const outB = this._outB, outW = this._outW;
            outB.fill(0);
            outW.fill(0);
            classifyLineDual(buf, n, outB, outW);

            const ls = this.lineShapes;
            const sc = this.shapeCount;
            const nLines = LINES.length;
            let baseB = L * SHAPE_COUNT;
            let baseW = nLines * SHAPE_COUNT + L * SHAPE_COUNT;

            for (let s = 0; s < SHAPE_COUNT; s++) {
                const oB = ls[baseB + s];
                const nB = outB[s];
                if (oB !== nB) { sc[s] += nB - oB; ls[baseB + s] = nB; }
                const oW = ls[baseW + s];
                const nW = outW[s];
                if (oW !== nW) { sc[SHAPE_COUNT + s] += nW - oW; ls[baseW + s] = nW; }
            }
        }

        /* ---------------- 胜负判定 ---------------- */

        /**
         * 判断「在 i 落子后」是否成五。
         * 全引擎最热的函数之一，直接沿 4 个方向数连通长度，不走棋型表。
         * @param {number} i 填充索引（该位置已经落了子）
         * @param {boolean} [exactFive=false] true 时只有恰好 5 才算赢（标准规则）
         */
        isFive(i, exactFive) {
            const p = this.cells[i];
            if (p !== BLACK && p !== WHITE) return false;
            const cells = this.cells;
            const s0 = STEP[0], s1 = STEP[1], s2 = STEP[2], s3 = STEP[3];

            for (let d = 0; d < 4; d++) {
                const step = d === 0 ? s0 : d === 1 ? s1 : d === 2 ? s2 : s3;
                let cnt = 1;
                let j = i + step;
                while (cells[j] === p) { cnt++; j += step; }
                j = i - step;
                while (cells[j] === p) { cnt++; j -= step; }
                if (exactFive ? cnt === 5 : cnt >= 5) return true;
            }
            return false;
        }

        /** 判断 i 落子后是否长连（>=6），禁手判定用 */
        isOverline(i) {
            const p = this.cells[i];
            if (p !== BLACK && p !== WHITE) return false;
            const cells = this.cells;
            for (let d = 0; d < 4; d++) {
                const step = STEP[d];
                let cnt = 1;
                let j = i + step;
                while (cells[j] === p) { cnt++; j += step; }
                j = i - step;
                while (cells[j] === p) { cnt++; j -= step; }
                if (cnt >= 6) return true;
            }
            return false;
        }

        /* ---------------- 调试 ---------------- */

        dump() {
            const glyph = ['.', 'X', 'O'];
            let s = '   ' + Array.from({ length: SIZE }, (_, i) =>
                String.fromCharCode(65 + i)).join(' ') + '\n';
            for (let y = 0; y < SIZE; y++) {
                s += String(y + 1).padStart(2, ' ') + ' ';
                for (let x = 0; x < SIZE; x++) s += glyph[this.cells[C.idx(x, y)]] + ' ';
                s += '\n';
            }
            return s;
        }

        /** 取某方某棋型的全盘计数 */
        count(p, shape) {
            return this.shapeCount[(p === BLACK ? 0 : 1) * SHAPE_COUNT + shape];
        }
    }

    Board.LINES = LINES;
    Board.CELL_LINE = CELL_LINE;
    Board.STEP = STEP;
    Board.classifyLineDual = classifyLineDual;
    Board.classifyBuffer = classifyBuffer;

    root.GMK.Board = Board;
    root.GMK.LINES = LINES;
    root.GMK.classifyBuffer = classifyBuffer;
    root.GMK.classifyLineDual = classifyLineDual;
    if (typeof module !== 'undefined' && module.exports) module.exports = Board;
})();
