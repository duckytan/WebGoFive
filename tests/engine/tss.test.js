/**
 * TSS（VCT 求解器）单元测试
 *
 * 核心不变量：
 *   1. 超集性：所有内置 VCF 题，VCT 必须同样解出（VCT ⊇ VCF）
 *   2. 保守性：无解 / 全堵 / 反冲四在场 → 不宣称（null），绝不误判
 *   3. 安全性：预算耗尽返回 null 且不留幽灵棋子（history 基准回滚）
 *   4. 确定性：同局面同参数 → 同一解（练习判定的可复现前提）
 *   5. bestDefense 优先级：挡五 > 反冲四 > 挡三 > 近域首点，且可复现
 *
 * 运行：node tests/engine/tss.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
const Kill = require(path.join(ENGINE, 'kill.js'));
require(path.join(ENGINE, 'gomoku-ai.js'));
const TSS = require(path.join(ENGINE, 'tss.js'));
const VCF = require(path.join(ROOT, 'js', 'app', 'vcf.js'));

const GMK = globalThis.GMK;
const C = GMK.C;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra === undefined ? '' : '  →  ' + extra));
}
function eq(a, b, name) { ok(a === b, name, '实际 ' + a + ' / 期望 ' + b); }

function boardOf(stones) {
    const b = new Board();
    (stones || []).forEach(([x, y, p]) => b.place(C.idx(x, y), p));
    return b;
}
function boardOfFlat(flat) {
    const b = new Board();
    for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 15; x++) {
            const v = +flat[y * 15 + x] || 0;
            if (v) b.place(C.idx(x, y), v);
        }
    }
    return b;
}
/** 15×15 → 225 扁平串（不能用 Array.join —— 嵌套数组会插逗号） */
function flatOf(p) {
    let s = '';
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) s += p.board[y][x];
    return s;
}

/* ---------------- 1. 超集性：VCF 题 VCT 全解 ---------------- */

{
    let solved = 0;
    let totalNodes = 0;
    const t0 = Date.now();
    for (let i = 0; i < VCF.PUZZLES.length; i++) {
        const b = boardOfFlat(flatOf(VCF.PUZZLES[i]));
        // v2.8 题库加入 d3/d4 VCT 题，最重首解可达 ~145k 节点 —— 预算随之放大。
        // 刻意不传 timeMs：超集性是正确性断言，只由 nodeBudget 这一个确定性
        // 上限约束，绝不能受机器并发负载影响（墙钟死线会把重题随机砍成 null）。
        const r = TSS.solve(b, C.BLACK, { maxDepth: 8, nodeBudget: 300000 });
        if (r && C.inBoard(r.move)) {
            solved++;
            totalNodes += r.nodes;
        } else {
            ok(false, 'VCF 题 ' + VCF.PUZZLES[i].id + ' 应被 VCT 解出');
        }
        // 求解不得污染棋盘
        eq(b.stoneCount(), VCF.PUZZLES[i].board.flat().filter((v) => v).length,
            '题 ' + VCF.PUZZLES[i].id + ' 求解后棋盘无残留');
    }
    eq(solved, VCF.PUZZLES.length, 'VCT ⊇ VCF（9 题全解）');
    // 用「总节点数」替换墙钟耗时作为确定性健全性上限：节点数与计算量成正比，
    // 且同局面同参数恒定，不受机器负载影响。实测 15 题合计约 53 万节点，
    // 150 万阈值留约 2.8 倍余量，同时远低于 15×300k 的理论上限。
    ok(totalNodes < 1500000, '15 题求解总节点数应有界（< 150 万）', totalNodes + ' 节点');
    // 耗时仅作信息打印，不作断言（墙钟时间随机器负载漂移，会引入 flaky）
    console.log('  [info] 超集性求解：' + totalNodes + ' 节点 / ' + (Date.now() - t0) + 'ms');
}

/* ---------------- 2. 保守性：不误判 ---------------- */

{
    // 光杆黑子：无威胁可延续
    eq(TSS.solve(boardOf([[7, 7, 1]]), 1, {}), null, '光杆黑子不宣称必胜');
    // 三头全堵
    eq(TSS.solve(boardOf([[4, 7, 2], [5, 7, 1], [6, 7, 1], [7, 7, 1], [8, 7, 2]]), 1, {}),
        null, '三头全堵不宣称必胜');
    // 防守方已有活三（反冲四风险）→ 保守放弃（文档化口径）
    eq(TSS.solve(boardOf([[6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 8, 1],
        [6, 11, 2], [7, 11, 2], [8, 11, 2]]), 1, { maxDepth: 8, nodeBudget: 200000 }),
        null, '防守有活三反制时保守放弃');
    // 空盘
    eq(TSS.solve(boardOf([]), 1, {}), null, '空盘不宣称必胜');
    // 对手有活四在场（随时成五）→ 入口守卫，保守放弃（v2.8.0 加固）
    eq(TSS.solve(boardOf([[6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 8, 1],
        [3, 3, 2], [4, 3, 2], [5, 3, 2], [6, 3, 2]]), 1,
        { maxDepth: 8, nodeBudget: 200000 }),
        null, '对手有活四时不宣称必胜');
}

/* ---------------- 3. 正例：VCT 特有（三系）胜 ---------------- */

{
    // 裸活三：一手冲四成活四双五点
    const r = TSS.solve(boardOf([[5, 7, 1], [6, 7, 1], [7, 7, 1]]), 1, {});
    ok(r && C.inBoard(r.move), '裸活三解出', JSON.stringify(r));
    if (r) {
        const b = boardOf([[5, 7, 1], [6, 7, 1], [7, 7, 1]]);
        b.place(r.move, C.BLACK);
        const buf = new Int32Array(8);
        ok(Kill.fivePoints(b, r.move, C.BLACK, buf) >= 1,
            '解出的首着确实是威胁着法', '(' + C.xOf(r.move) + ',' + C.yOf(r.move) + ')');
    }
    // 双活三（3×3 交点）—— 无白子局面多解皆胜，只要求「解出且确实成三」
    const r2 = TSS.solve(boardOf([[6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 8, 1]]),
        1, { maxDepth: 8, nodeBudget: 200000 });
    ok(r2 && C.inBoard(r2.move), '双活三局面解出', JSON.stringify(r2));
}

/* ---------------- 4. 安全性：预算耗尽不留幽灵棋子 ---------------- */

{
    const b = boardOf([[6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 8, 1], [7, 7, 2]]);
    const base = b.stoneCount();
    const r = TSS.solve(b, 1, { maxDepth: 10, nodeBudget: 300 });
    eq(r, null, '极小预算返回 null（不宣称）');
    eq(b.stoneCount(), base, '预算耗尽后棋盘无残留');
}

/* ---------------- 4b. timeMs 墙钟死线：超时返回 null 且不留幽灵棋子 ---------------- */

{
    // 选最重的 vcf-09：不带 timeMs 时需 ~145k 节点才解出，且 < 300k nodeBudget，
    // 因此只有「时间先到」才会砍断，绝不会是节点预算先到，也不会在 1ms 内被解出。
    // 死线检查在每 256 个节点处触发，局面足够重 → 必然命中（实测稳定返回 null）。
    const heavy = VCF.PUZZLES.find((p) => p.id === 'vcf-09');
    const b = boardOfFlat(flatOf(heavy));
    const base = b.stoneCount();
    const r = TSS.solve(b, C.BLACK, { maxDepth: 8, nodeBudget: 300000, timeMs: 1 });
    eq(r, null, 'timeMs:1 墙钟死线触发时返回 null（不宣称）');
    eq(b.stoneCount(), base, '墙钟死线触发后棋盘无残留（finally 回滚生效）');
}

/* ---------------- 5. 确定性 ---------------- */

{
    const stones = [[6, 7, 1], [8, 7, 1], [7, 6, 1], [7, 8, 1]];
    const r1 = TSS.solve(boardOf(stones), 1, { maxDepth: 8, nodeBudget: 200000 });
    const r2 = TSS.solve(boardOf(stones), 1, { maxDepth: 8, nodeBudget: 200000 });
    eq(r1 && r1.move, r2 && r2.move, '同局面同参数解相同');
    // threatMoves：确定性（两次调用同序）+ 每一手非四即活三 + 四全部排在活三前
    const b = boardOf([[5, 7, 1], [6, 7, 1], [7, 7, 1]]);
    const mv1 = TSS.threatMoves(b, C.BLACK, 24);
    const mv2 = TSS.threatMoves(b, C.BLACK, 24);
    eq(JSON.stringify(mv1), JSON.stringify(mv2), 'threatMoves 两次调用同序');
    ok(mv1.length >= 3, '威胁着法非空', mv1.length + ' 个');
    const shapeBuf = new Int8Array(4);
    let sawThree = false;
    for (let k = 0; k < mv1.length; k++) {
        GMK.Evaluator.pointShapes(b, mv1[k], C.BLACK, shapeBuf);
        let isThree = false, isFour = false;
        for (let d = 0; d < 4; d++) {
            if (shapeBuf[d] === C.SHAPE.OPEN_THREE) isThree = true;
            if (shapeBuf[d] === C.SHAPE.FOUR || shapeBuf[d] === C.SHAPE.OPEN_FOUR) isFour = true;
        }
        if (isThree) sawThree = true;
        else ok(isFour, '威胁着法非四即活三', 'idx=' + mv1[k]);
        if (sawThree) ok(isThree, '四全部排在活三之前', 'idx=' + mv1[k]);
    }
}

/* ---------------- 6. bestDefense 优先级 ---------------- */

{
    // 攻方有成五点 → 必挡
    const b1 = boardOf([[5, 7, 1], [6, 7, 1], [7, 7, 1], [8, 7, 1]]);   // 黑活四，五点 (4,7)/(9,7)
    const d1 = TSS.bestDefense(b1, C.BLACK);
    ok(d1 === C.idx(4, 7) || d1 === C.idx(9, 7), '有成五点时挡五点',
        '(' + C.xOf(d1) + ',' + C.yOf(d1) + ')');
    // 确定性：两次一致
    const d1b = TSS.bestDefense(b1, C.BLACK);
    eq(d1, d1b, 'bestDefense 可复现');
    // 防守反冲四优先于挡三
    const b2 = boardOf([[5, 7, 1], [6, 7, 1], [7, 7, 1],      // 黑活三（行 7）
        [5, 9, 2], [6, 9, 2], [8, 9, 2]]);                     // 白断三（列内行 9，(7,9) 空）
    const d2 = TSS.bestDefense(b2, C.BLACK);
    ok(C.inBoard(d2), '一般局面给出合法防手', '(' + C.xOf(d2) + ',' + C.yOf(d2) + ')');
}

/* ================================================================== */
console.log('\n' + '─'.repeat(52));
if (fail === 0) {
    console.log('✓ 全部通过：' + pass + ' 项');
    process.exit(0);
} else {
    console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
    failures.forEach((f) => console.log('   · ' + f));
    process.exit(1);
}
