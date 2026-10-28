/**
 * 引擎单元测试
 *
 * 运行：node tests/engine.test.js
 * 不依赖任何第三方测试框架，失败时以非 0 退出码结束（可直接接 CI）。
 */

'use strict';

const path = require('path');
const ENGINE = path.join(__dirname, '..', '..', 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
const C = globalThis.GMK.C;
const Ev = globalThis.GMK.Evaluator;

const S = C.SHAPE;
const SHAPE_NAME = ['FIVE', 'OPEN_FOUR', 'FOUR', 'OPEN_THREE', 'SLEEP_THREE', 'OPEN_TWO', 'SLEEP_TWO'];

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra ? '  →  ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
}

function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${expected}，实际 ${actual}`);
}

/** 造一个棋盘：list = [[x,y], ...] 依次落黑子 */
function makeBoard(list, p) {
    const b = new Board();
    for (const [x, y] of list) b.place(C.idx(x, y), p || C.BLACK);
    return b;
}

/** 取某方棋型计数的可读快照 */
function shapes(b, p) {
    const o = {};
    for (let s = 0; s < 7; s++) {
        const v = b.count(p, s);
        if (v) o[SHAPE_NAME[s]] = v;
    }
    return o;
}

function section(title) { console.log('\n' + title); }

/* ================================================================== *
 * 1. 线表结构
 * ================================================================== */
section('[1] 线表');
eq(Board.LINES.length, 72, '应有 72 条可能成五的线（15 行 + 15 列 + 21 主对角 + 21 副对角）');

{
    let lenOk = true, dupOk = true;
    for (const L of Board.LINES) {
        if (L.length < 5) lenOk = false;
        const set = new Set(L);
        if (set.size !== L.length) dupOk = false;
    }
    ok(lenOk, '每条线长度 >= 5');
    ok(dupOk, '同一条线内无重复格子');
}

// 中心格 (7,7) 应恰好属于 4 条线
{
    const i = C.idx(7, 7);
    const ids = [0, 1, 2, 3].map(d => Board.CELL_LINE[i * 4 + d]);
    ok(ids.every(v => v >= 0), '(7,7) 属于 4 条线');
    eq(new Set(ids).size, 4, '(7,7) 的 4 条线互不相同');
}

/* ================================================================== *
 * 2. 棋型分类
 * ================================================================== */
section('[2] 棋型分类');

// 2.1 五连
{
    const b = makeBoard([[3, 0], [4, 0], [5, 0], [6, 0], [7, 0]]);
    eq(b.count(C.BLACK, S.FIVE), 1, '横向五连 → FIVE=1');
    ok(b.isFive(C.idx(5, 0)), 'isFive 判定横向五连');
}

// 2.2 活四：两端皆空
{
    const b = makeBoard([[3, 0], [4, 0], [5, 0], [6, 0]]);
    eq(b.count(C.BLACK, S.OPEN_FOUR), 1, '四子两端空 → OPEN_FOUR=1');
    eq(b.count(C.BLACK, S.FOUR), 0, '活四不应同时记成 FOUR');
}

// 2.3 冲四：一端被对方堵
{
    const b = new Board();
    [[3, 0], [4, 0], [5, 0], [6, 0]].forEach(([x, y]) => b.place(C.idx(x, y), C.BLACK));
    b.place(C.idx(2, 0), C.WHITE);
    eq(b.count(C.BLACK, S.FOUR), 1, '一端被堵的四 → FOUR=1');
    eq(b.count(C.BLACK, S.OPEN_FOUR), 0, '被堵的四不应记成 OPEN_FOUR');
}

// 2.4 嵌四 11011：中间空一格
{
    const b = makeBoard([[3, 0], [4, 0], [6, 0], [7, 0]]);
    eq(b.count(C.BLACK, S.FOUR), 1, '嵌四 11011 → FOUR=1');
}

// 2.5 活三
{
    const b = makeBoard([[4, 0], [5, 0], [6, 0]]);
    eq(b.count(C.BLACK, S.OPEN_THREE), 1, '三子两侧留两格 → OPEN_THREE=1');
    eq(b.count(C.BLACK, S.SLEEP_THREE), 0, '活三不应同时记成 SLEEP_THREE');
}

// 2.6 眠三：一端被堵
{
    const b = new Board();
    [[4, 0], [5, 0], [6, 0]].forEach(([x, y]) => b.place(C.idx(x, y), C.BLACK));
    b.place(C.idx(3, 0), C.WHITE);
    eq(b.count(C.BLACK, S.SLEEP_THREE), 1, '一端被堵的三 → SLEEP_THREE=1');
    eq(b.count(C.BLACK, S.OPEN_THREE), 0, '眠三不应记成 OPEN_THREE');
}

// 2.7 跳活三 _XX_X_
{
    const b = makeBoard([[4, 0], [5, 0], [7, 0]]);
    eq(b.count(C.BLACK, S.OPEN_THREE), 1, '跳活三 _XX_X_ → OPEN_THREE=1');
}

// 2.8 跳活三 _X_XX_
{
    const b = makeBoard([[4, 0], [6, 0], [7, 0]]);
    eq(b.count(C.BLACK, S.OPEN_THREE), 1, '跳活三 _X_XX_ → OPEN_THREE=1');
}

// 2.9 双活三：两个方向各一个活三，应分别计数
{
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [7, 4], [7, 5], [7, 6]]);
    eq(b.count(C.BLACK, S.OPEN_THREE), 2, '十字双活三 → OPEN_THREE=2');
}

// 2.10 长连不应被算成五连（禁手判定另算）
{
    const b = makeBoard([[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0]]);
    ok(b.isFive(C.idx(5, 0)), '无禁手规则下长连算赢（>=5）');
    ok(!b.isFive(C.idx(5, 0), true), '标准规则下长连不算赢（exactFive）');
    ok(b.isOverline(C.idx(5, 0)), 'isOverline 能识别长连');
}

/* ------------------------------------------------------------------ *
 * 2.11~2.14 死棋型
 *
 * 这一组是踩过坑之后补的：早先的实现只判断「是不是四/三/二」，
 * 不判断「还活不活」。于是 `OXXXXO` 这种两头堵死的四照样记成冲四，
 * 而评估函数里「两个四 = 双四必胜」的规则会把它直接拉到 900 万分。
 * 实测后果：引擎整局都以为赢定了，实际那两条线根本补不成五。
 * ------------------------------------------------------------------ */

// 2.11 死四：两头被对方堵死，没有成五点
{
    const b = new Board();
    [[4, 7], [5, 7], [6, 7], [7, 7]].forEach(([x, y]) => b.place(C.idx(x, y), C.BLACK));
    b.place(C.idx(3, 7), C.WHITE);
    b.place(C.idx(8, 7), C.WHITE);
    eq(b.count(C.BLACK, S.FOUR), 0, '两头堵死的四 → 不计 FOUR');
    eq(b.count(C.BLACK, S.OPEN_FOUR), 0, '两头堵死的四 → 不计 OPEN_FOUR');
}

// 2.12 死三
{
    const b = new Board();
    [[5, 7], [6, 7], [7, 7]].forEach(([x, y]) => b.place(C.idx(x, y), C.BLACK));
    b.place(C.idx(4, 7), C.WHITE);
    b.place(C.idx(8, 7), C.WHITE);
    eq(b.count(C.BLACK, S.OPEN_THREE), 0, '两头堵死的三 → 不计 OPEN_THREE');
    eq(b.count(C.BLACK, S.SLEEP_THREE), 0, '两头堵死的三 → 不计 SLEEP_THREE');
}

// 2.13 死二
{
    const b = new Board();
    [[6, 7], [7, 7]].forEach(([x, y]) => b.place(C.idx(x, y), C.BLACK));
    b.place(C.idx(5, 7), C.WHITE);
    b.place(C.idx(8, 7), C.WHITE);
    eq(b.count(C.BLACK, S.OPEN_TWO), 0, '两头堵死的二 → 不计 OPEN_TWO');
    eq(b.count(C.BLACK, S.SLEEP_TWO), 0, '两头堵死的二 → 不计 SLEEP_TWO');
}

// 2.14 贴边不算死：边界只堵一头，另一头还有成五点
{
    const b = makeBoard([[0, 7], [1, 7], [2, 7], [3, 7]]);
    eq(b.count(C.BLACK, S.FOUR), 1, '贴边四子 → 仍是 FOUR（另一头空着）');

    const b2 = makeBoard([[0, 7], [1, 7], [2, 7]]);
    eq(b2.count(C.BLACK, S.SLEEP_THREE), 1, '贴边三子 → SLEEP_THREE');
}

// 2.15 评估必须零和：evaluate(p) === -evaluate(opp)
{
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [7, 4], [7, 5], [7, 6]]);
    eq(Ev.evaluate(b, C.BLACK) + Ev.evaluate(b, C.WHITE), 0,
        'evaluate 必须严格零和（negamax 的前提）');
}

/* ================================================================== *
 * 3. 增量一致性：place / unplace 必须严格对称
 * ================================================================== */
section('[3] 增量更新对称性');

{
    const b = new Board();
    const seq = [
        [7, 7, 1], [6, 7, 2], [7, 8, 1], [8, 6, 2], [5, 7, 1],
        [8, 7, 2], [6, 6, 1], [9, 9, 2], [4, 7, 1], [10, 10, 2]
    ];
    const snaps = [];
    for (const [x, y, p] of seq) {
        b.place(C.idx(x, y), p);
        snaps.push({ counts: Array.from(b.shapeCount), n: b.stoneCount() });
    }
    // 逐步撤销，每撤销一步应与上一步的快照完全一致
    let symmetric = true;
    for (let k = seq.length - 1; k >= 1; k--) {
        b.unplace();
        const prev = snaps[k - 1];
        const cur = Array.from(b.shapeCount);
        if (cur.some((v, i) => v !== prev.counts[i])) symmetric = false;
        if (b.stoneCount() !== prev.n) symmetric = false;
    }
    ok(symmetric, 'place / unplace 完全对称，棋型计数无漂移');
}

// 3.1 与「从头重建」对比：增量结果必须等于全量重算
{
    const b = new Board();
    const seq = [
        [7, 7, 1], [6, 7, 2], [7, 8, 1], [8, 6, 2], [5, 7, 1],
        [8, 7, 2], [6, 6, 1], [9, 9, 2]
    ];
    for (const [x, y, p] of seq) b.place(C.idx(x, y), p);
    const incremental = Array.from(b.shapeCount);

    const rebuilt = new Board();
    for (const [x, y, p] of seq) rebuilt.place(C.idx(x, y), p);
    const full = Array.from(rebuilt.shapeCount);

    ok(incremental.every((v, i) => v === full[i]), '增量统计 == 全量重建');
}

/* ================================================================== *
 * 4. 边界与角落
 * ================================================================== */
section('[4] 边界');

{
    // 贴着左上角的三，只有一侧有空间 → 眠三而不是活三
    const b = makeBoard([[0, 0], [1, 0], [2, 0]]);
    eq(b.count(C.BLACK, S.SLEEP_THREE), 1, '角落三子 → SLEEP_THREE=1（左边是墙）');
    eq(b.count(C.BLACK, S.OPEN_THREE), 0, '角落三子不是活三');
}

{
    // 贴边的五连必须能判出来
    const b = makeBoard([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    ok(b.isFive(C.idx(0, 0)), '贴边五连可判定');
}

{
    // 副对角方向
    const b = makeBoard([[10, 4], [9, 5], [8, 6], [7, 7], [6, 8]]);
    ok(b.isFive(C.idx(8, 6)), '副对角五连可判定');
}

{
    // 棋盘外不应被当成空点：一条 4 子贴边的线不应算活四
    const b = makeBoard([[11, 0], [12, 0], [13, 0], [14, 0]]);
    eq(b.count(C.BLACK, S.OPEN_FOUR), 0, '贴边四子不是活四（右侧是墙）');
    eq(b.count(C.BLACK, S.FOUR), 1, '贴边四子是冲四');
}

/* ================================================================== *
 * 汇总
 * ================================================================== */
console.log('\n' + '='.repeat(50));
if (fail === 0) {
    console.log(`全部通过：${pass} 项`);
    process.exit(0);
} else {
    console.log(`通过 ${pass} 项，失败 ${fail} 项：`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
}
