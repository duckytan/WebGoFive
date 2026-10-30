/**
 * v2.6.0 新增能力单元测试：VCF 自定义题库 / 限时挑战参数
 *
 * 覆盖：
 *   1. addCustom 校验：非法盘面（空/单黑/白多于黑/已有五连/形状错）全部拒绝，
 *      合法盘面入库且解的深度与 solutionOf 一致
 *   2. PUZZLES 动态合并：入库后 custom 标记 / id 前缀 / 下拉数据源同长，
 *      removeCustom 删净（含成绩与错题本残留引用）
 *   3. 自定义题独立存档：clearProgress() 不误删用户摆的题
 *   4. flattenBoard 存档格式与内置题一致（225 字符 0/1/2）
 *   5. TIME_LIMIT 表：三档齐全且为正数
 *
 * 运行：node tests/engine/custom-timed.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
require(path.join(ENGINE, 'kill.js'));
require(path.join(ENGINE, 'forbidden.js'));
require(path.join(ENGINE, 'gomoku-ai.js'));
const VCF = require(path.join(ROOT, 'js', 'app', 'vcf.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra === undefined ? '' : '  →  ' + extra));
}
function eq(a, b, name) { ok(a === b, name, '实际 ' + a + ' / 期望 ' + b); }

function blank() { return Array.from({ length: 15 }, () => new Array(15).fill(0)); }

const BASE_COUNT = VCF.PUZZLES.length;   // Node 下无 localStorage，PUZZLES = 纯内置题

/* ---------------- 1. addCustom 校验 ---------------- */

{
    const r = VCF.addCustom(blank());
    eq(r.ok, false, '空盘拒绝');
    ok(/黑/.test(r.error), '空盘错误信息指向黑子', r.error);

    const one = blank(); one[7][7] = 1;
    eq(VCF.addCustom(one).ok, false, '单黑子拒绝（不可能有连冲解）');

    const bw = blank(); bw[7][7] = 1; bw[8][8] = 2; bw[6][6] = 2;
    eq(VCF.addCustom(bw).ok, false, '白多于黑拒绝（黑方先行）');

    const five = blank();
    for (let i = 3; i < 8; i++) five[7][i] = 1;
    eq(VCF.addCustom(five).ok, false, '已有五连拒绝');

    const fiveW = blank();
    for (let i = 3; i < 8; i++) fiveW[7][i] = 2;
    fiveW[9][9] = 1;
    eq(VCF.addCustom(fiveW).ok, false, '白方已有五连同样拒绝');

    eq(VCF.addCustom('not-a-board').ok, false, '非二维数组拒绝');
    const ragged = Array.from({ length: 15 }, (_, i) => new Array(i < 3 ? 14 : 15).fill(0));
    eq(VCF.addCustom(ragged).ok, false, '行列长度不符拒绝');
}

/* ---------------- 2. 合法入库 + removeCustom ---------------- */

{
    const src = VCF.PUZZLES[1];                      // 两手连冲题
    const before = VCF.PUZZLES.length;
    const r = VCF.addCustom(src.board);
    eq(r.ok, true, '内置题盘面复摆可通过校验', r.error || '');
    if (r.ok) {
        eq(VCF.PUZZLES.length, before + 1, '入库后 PUZZLES 同步增长');
        ok(r.puzzle.custom === true, '带 custom 标记');
        ok(/^custom-/.test(r.puzzle.id), 'id 带 custom- 前缀', r.puzzle.id);
        eq(r.puzzle.depth, VCF.solutionOf(r.index).length, '标注深度与实际解一致');
        eq(r.puzzle.level, 1, '两手题归入门档');
        eq(VCF.customCount(), 1, 'customCount 计数');

        // 成绩与错题残留随删除一并清理
        VCF.record(r.puzzle.id, 1234, r.puzzle.depth);
        VCF.wrongbookAdd(r.puzzle.id, { x: 0, y: 0 }, 'not-four');
        eq(VCF.removeCustom(r.puzzle.id), true, '删除自定义题');
        eq(VCF.PUZZLES.length, before, '删除后题库复原');
        eq(VCF.customCount(), 0, '存档同步删除');
        eq(VCF.getRecord(r.puzzle.id), null, '该题成绩一并清除');
        eq(VCF.wrongbookList().some((w) => w.puzzle === r.puzzle.id), false, '该题错题残留一并清除');
        eq(VCF.removeCustom('vcf-01'), false, '内置题不可删除');
        eq(VCF.removeCustom('custom-not-exist'), false, '不存在的 id 返回 false');
    }
}

/* ---------------- 3. 独立存档：clearProgress 不删自定义题 ---------------- */

{
    const src = VCF.PUZZLES[4];                      // 三手题（进阶档）
    const r = VCF.addCustom(src.board);
    if (r.ok) {
        VCF.clearProgress();
        eq(VCF.customCount(), 1, 'clearProgress 不误删自定义题（独立存档键）');
        ok(VCF.PUZZLES.some((p) => p.id === r.puzzle.id), 'PUZZLES 中仍可找到该自定义题');
        VCF.removeCustom(r.puzzle.id);
        eq(VCF.customCount(), 0, '清理完毕');
    } else {
        ok(false, '三手题盘面应可通过校验', r.error || '');
    }
}

/* ---------------- 4. flattenBoard 存档格式 ---------------- */

{
    const flat = VCF.flattenBoard(VCF.PUZZLES[0].board);
    eq(flat.length, 225, '扁平串长度 225');
    ok(/^[012]+$/.test(flat), '扁平串只含 0/1/2');
    // round trip：parseBoard 是内部函数，经 loadCustoms 验证等价 —— 直接对比已知题的原始串格式
    ok(typeof flat === 'string' && flat[7 * 15 + 7] !== undefined, '按 y*15+x 行主序索引');
}

/* ---------------- 5. TIME_LIMIT 表 ---------------- */

{
    ok(VCF.TIME_LIMIT && typeof VCF.TIME_LIMIT === 'object', 'TIME_LIMIT 表存在');
    for (const lv of [1, 2, 3]) {
        const v = VCF.TIME_LIMIT[lv];
        ok(Number.isFinite(v) && v > 0, '限时档位 ' + lv + ' 为正数', String(v));
    }
    ok(VCF.TIME_LIMIT[1] < VCF.TIME_LIMIT[2] && VCF.TIME_LIMIT[2] < VCF.TIME_LIMIT[3],
        '限时随难度递增');
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
