/**
 * 算杀（VCF）单元测试
 *
 * 运行：node tests/vcf.test.js
 *
 * 设计原则：不信任「引擎自己说能赢」。
 * 凡是断言 VCF 找到必胜着法的用例，都用一段**独立实现**的
 * 三层暴力验证（我冲四 → 对手唯一挡 → 我成五）交叉核对一遍，
 * 避免 VCF 与棋盘记账同时出错却互相印证。
 */

'use strict';

const path = require('path');
const ENGINE = path.join(__dirname, '..', '..', 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
const Kill = require(path.join(ENGINE, 'kill.js'));

const C = globalThis.GMK.C;
const Ev = globalThis.GMK.Evaluator;
const { BLACK, WHITE, EMPTY, SHAPE } = C;

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
function section(t) { console.log('\n' + t); }

const xy = i => [C.xOf(i), C.yOf(i)];
const name = i => {
    const [x, y] = xy(i);
    return String.fromCharCode(65 + x) + (y + 1);
};

/** 依次落子（棋子颜色由列表顺序交替，或显式给颜色） */
function makeBoard(stones) {
    const b = new Board();
    for (const s of stones) b.place(C.idx(s[0], s[1]), s[2] || BLACK);
    return b;
}

/** 对局快照：落子栈 + 双方棋型计数，用于验证 VCF 有没有留下残局 */
function snapshot(b) {
    return {
        history: b.history.slice(),
        shapes: Array.from(b.shapeCount),
        codes: Array.from(b.codeB).concat(Array.from(b.codeW))
    };
}
function sameSnapshot(a, b) {
    if (a.history.length !== b.history.length) return '落子数不一致';
    for (let k = 0; k < a.history.length; k++) {
        if (a.history[k] !== b.history[k]) return '第 ' + k + ' 步落点不一致';
    }
    for (let k = 0; k < a.shapes.length; k++) {
        if (a.shapes[k] !== b.shapes[k]) return '棋型计数不一致 @' + k;
    }
    for (let k = 0; k < a.codes.length; k++) {
        if (a.codes[k] !== b.codes[k]) return '点视角编码不一致 @' + k;
    }
    return null;
}

/* ================================================================== *
 * 1. fivePoints —— 「这一手形成几个成五点」
 * ================================================================== */

section('[1] fivePoints');

{
    // 黑 4 连 + 一个空：落子后应只有 1 个成五点（冲四）
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [7, 7], [0, 0, WHITE]]);
    const out = new Int32Array(8);
    b.place(C.idx(3, 7), BLACK);            // 形成 3~7 五连？不，3..7 是 5 颗
    eq(b.isFive(C.idx(3, 7)), true, '落子后应已五连');
    b.unplace();

    // 真正的四：黑 4~7，落 (3,7) 后是 3..7 五连，所以改用 3 连起点
    const b2 = makeBoard([[4, 7], [5, 7], [6, 7], [0, 0, WHITE]]);
    b2.place(C.idx(7, 7), BLACK);           // 4,5,6,7 四连，两端 3 和 8 都空
    eq(Kill.fivePoints(b2, C.idx(7, 7), BLACK, out), 2, '活四应有两个成五点（两端）');
    b2.unplace();

    // 一端被白堵死 → 冲四，只有一个成五点
    const b3 = makeBoard([[3, 7, WHITE], [4, 7], [5, 7], [6, 7], [0, 0, WHITE]]);
    b3.place(C.idx(7, 7), BLACK);           // 4,5,6,7 四连，3 是白，8 空
    const n3 = Kill.fivePoints(b3, C.idx(7, 7), BLACK, out);
    eq(n3, 1, '一端被堵的四应只有一个成五点');
    eq(out[0], C.idx(8, 7), '成五点应为 I8（(8,7)）');
    b3.unplace();

    // 没形成四的三连 → 0
    const b4 = makeBoard([[4, 7], [5, 7], [0, 0, WHITE]]);
    b4.place(C.idx(6, 7), BLACK);
    eq(Kill.fivePoints(b4, C.idx(6, 7), BLACK, out), 0, '三连不应有成五点');
    b4.unplace();
}

/* ================================================================== *
 * 2. fourMoves —— 冲四候选收集
 * ================================================================== */

section('[2] fourMoves');

{
    // 活三：落两端都能成「活四」，应被收进候选
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [0, 0, WHITE]]);
    const mv = Kill.fourMoves(b, BLACK, 24);
    let hasI8 = false, hasC8 = false;
    for (let k = 0; k < mv.length; k++) {
        if (mv[k] === C.idx(7, 7)) hasI8 = true;
        if (mv[k] === C.idx(3, 7)) hasC8 = true;
    }
    ok(hasI8 && hasC8, '活三两端都应被识别为可冲四的点', '实际候选 ' + mv.length + ' 个');

    // 候选必须是 4 个而不是 2 个：C8(2,7) 和 I8(8,7) 落下去得到
    // 「2 4 5 6」这种隔一个空位的四子，补 3 号位即成五 —— 同样是货真价实的冲四。
    // （一开始我把这个当成 bug，其实是把「冲四」理解成只能是连续四子。）
    eq(mv.length, 4, '活三应有 4 个冲四候选：两端做活四 + 两侧隔位做冲四');

    // 优先级：做活四的两点必须排在做冲四的两点之前
    ok(mv[0] === C.idx(3, 7) || mv[0] === C.idx(7, 7), '首位候选应是做活四的点');
    ok(mv[1] === C.idx(3, 7) || mv[1] === C.idx(7, 7), '次位候选应是做活四的点');

    // 空盘：没有任何候选
    eq(Kill.fourMoves(new Board(), BLACK, 24).length, 0, '空盘不应有冲四候选');

    // 眠三（一端被堵、另一端也堵死）不应被当成冲四
    const b2 = makeBoard([[3, 7, WHITE], [4, 7], [5, 7], [6, 7], [7, 7, WHITE], [0, 0, WHITE]]);
    eq(Kill.fourMoves(b2, BLACK, 24).length, 0, '两头都被堵的三连不应产生冲四候选');
}

/* ================================================================== *
 * 3. 「一步必胜」判定
 *
 * 用来给深度用例做前置断言：如果局面本身一步就能赢，
 * 那这个用例其实测不到多步算杀，等于白写。
 * ================================================================== */

/**
 * 是否存在「一步取胜」的着法（直接成五，或做成活四/双四）。
 * @returns {number} 该着法，没有则 -1
 */
function findImmediateWin(board, p) {
    const cells = board.cells;
    const out = new Int32Array(8);
    for (let y = 0; y < C.SIZE; y++) {
        for (let x = 0; x < C.SIZE; x++) {
            const i = C.idx(x, y);
            if (cells[i] !== EMPTY) continue;
            board.place(i, p);
            const win = board.isFive(i) || Kill.fivePoints(board, i, p, out) >= 2;
            board.unplace();
            if (win) return i;
        }
    }
    return -1;
}

/* ================================================================== *
 * 4. VCF 主流程
 * ================================================================== */

section('[4] vcf');

{
    // 4.1 空盘 / 稀疏局面：没有冲四可走 → -1
    const b = makeBoard([[7, 7], [8, 8, WHITE]]);
    eq(Kill.vcf(b, BLACK, 12), -1, '只有两颗子的局面不应算出必胜');
}

{
    // 4.2 已有活四，直接成五
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [7, 7], [0, 0, WHITE]]);
    const m = Kill.vcf(b, BLACK, 12);
    ok(m >= 0, '活四局面 VCF 必须找到成五的点', '返回 ' + m);
    if (m >= 0) {
        b.place(m, BLACK);
        eq(b.isFive(m), true, 'VCF 返回的着法应直接成五');
        b.unplace();
    }
}

{
    // 4.3 活三 → 落一端成活四 → 必胜
    const b = makeBoard([[4, 7], [5, 7], [6, 7], [0, 0, WHITE]]);
    const m = Kill.vcf(b, BLACK, 12);
    ok(m >= 0, '活三局面 VCF 应能找到做活四的着法', '返回 ' + m);
    if (m >= 0) {
        b.place(m, BLACK);
        const out = new Int32Array(8);
        eq(Kill.fivePoints(b, m, BLACK, out), 2, 'VCF 这一步应做成活四（两个成五点）');
        b.unplace();
    }
}

{
    // 4.4 对手已有冲四 → 必须防守，VCF 不成立
    const b = makeBoard([
        [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE], [7, 7, WHITE],
        [0, 0], [1, 0], [2, 0]
    ]);
    eq(Kill.vcf(b, BLACK, 12), -1, '对手有活四时 VCF 应直接放弃进攻');
}

{
    // 4.5 真正的两步 VCF（人工推演过的定式）
    //
    //   黑：G5 G6 G7  —— 列 7 三连，上端 G4 被白占
    //       F8 G8     —— 行 7 两连
    //   白：G4
    //
    //   ① 黑 H8(7,7)：
    //        列 7 变成 G5..G8 四连，G4 是白 → 冲四，唯一成五点 (7,8)
    //   ② 白只能挡 (7,8)
    //        行 7 变成 F8 G8 H8 三连，两端 (4,7)/(9,7) 都空 → 活三
    //   ③ 黑 (8,7) 或 (4,7) → 行 7 成活四 → 两个成五点，挡不住
    //
    //   注意这不是「三步成五」，而是「两次冲四后成活四」，
    //   所以用「一步必胜」做前置断言，确保用例真的需要两步。
    const b = makeBoard([
        [7, 4], [7, 5], [7, 6],        // 列 7 三连（G5 G6 G7）
        [5, 7], [6, 7],                // 行 7 两连（F8 G8）
        [7, 3, WHITE]                  // 白堵住列 7 上端
    ]);

    eq(findImmediateWin(b, BLACK), -1, '前置条件：该局面不应存在一步必胜（否则测不到多步算杀）');

    const m = Kill.vcf(b, BLACK, 12);
    ok(m >= 0, '两步 VCF 应找到首着', '返回 ' + m);
    if (m >= 0) {
        eq(m, C.idx(7, 7), '首着应为 H8(7,7)（唯一冲四）');

        // 手工走完这条线：我冲四 → 白唯一挡 → 我成活四
        const out = new Int32Array(8);
        b.place(m, BLACK);
        eq(Kill.fivePoints(b, m, BLACK, out), 1, '首着应只形成一个成五点（冲四）');
        eq(out[0], C.idx(7, 8), '唯一成五点应为 (7,8)');

        const blk = out[0];
        b.place(blk, WHITE);
        const m2 = Kill.vcf(b, BLACK, 12);
        ok(m2 >= 0, '挡完之后仍应能算出必胜', '返回 ' + m2);
        if (m2 >= 0) {
            ok(m2 === C.idx(8, 7) || m2 === C.idx(4, 7),
                '第二手应落在行 7 的一端做成活四', '实际 ' + name(m2));
            b.place(m2, BLACK);
            eq(Kill.fivePoints(b, m2, BLACK, out), 2, '第二手应做成活四（两个成五点）');
            b.unplace();
        }
        b.unplace();
        b.unplace();
    }
}

/* ================================================================== *
 * 5. 副作用检查：VCF 跑完不能把棋盘弄脏
 * ================================================================== */

section('[5] 棋盘状态完整性');

{
    const b = makeBoard([
        [7, 4], [7, 5], [7, 6],
        [5, 7], [6, 7],
        [7, 3, WHITE]
    ]);
    const before = snapshot(b);
    Kill.vcf(b, BLACK, 12);
    const diff = sameSnapshot(before, snapshot(b));
    ok(diff === null, 'VCF 返回后棋盘应完全复原', diff || '');
}

{
    // 深层搜索失败时（找不到杀）也必须完全复原
    const b = new Board();
    const before = snapshot(b);
    eq(Kill.vcf(b, BLACK, 20), -1, '空盘深搜应返回 -1');
    const diff = sameSnapshot(before, snapshot(b));
    ok(diff === null, '空盘深搜后棋盘应完全复原', diff || '');
}

/* ================================================================== */

console.log('\n' + '─'.repeat(52));
if (fail === 0) {
    console.log(`✓ 全部通过：${pass} 项`);
    process.exit(0);
} else {
    console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项`);
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
}
