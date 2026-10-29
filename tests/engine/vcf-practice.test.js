/**
 * VCF 连冲练习（js/app/vcf.js）单元测试
 *
 * 核心原则：**逐题用引擎复验，不信任题库里写的东西**。
 *   1. 每道题都必须真的有连冲解（Kill.vcf ≥ 0）
 *   2. 顺着解走，每一手都必须真的是冲四（fivePoints ∈ {1} 或 ≥2）
 *   3. 实际深度必须与题面标注的 depth 一致（防止难度标错）
 *   4. 会话状态机：非冲四必须被拒且不留子、撤销要能还原、提示点必须是冲四、
 *      一路照提示走必须通关
 *
 * 运行：node tests/engine/vcf-practice.test.js
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
const VCF = require(path.join(ROOT, 'js', 'app', 'vcf.js'));

const C = globalThis.GMK.C;
const { BLACK, WHITE, EMPTY } = C;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra === undefined ? '' : '  →  ' + extra));
}
function eq(a, b, name) { ok(a === b, name, '实际 ' + a + ' / 期望 ' + b); }

function toEngine(board2d) {
    const b = new Board();
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
        if (board2d[y][x]) b.place(C.idx(x, y), board2d[y][x]);
    }
    return b;
}
function nm(p) { return String.fromCharCode(65 + p.x) + (p.y + 1); }

/* ================================================================== */
console.log('VCF 连冲练习 —— 题库复验');
console.log('─'.repeat(52));

ok(VCF.PUZZLES.length >= 8, '题库至少 8 道', VCF.PUZZLES.length + ' 道');

for (let k = 0; k < VCF.PUZZLES.length; k++) {
    const pz = VCF.PUZZLES[k];
    const tag = pz.id + '(' + pz.title + ')';

    // ① 题面基本合法性
    const eng = toEngine(pz.board);
    let blacks = 0, whites = 0;
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
        if (pz.board[y][x] === BLACK) blacks++;
        if (pz.board[y][x] === WHITE) whites++;
    }
    ok(blacks >= 4 && whites >= 3, tag + ' 子力合理', '黑' + blacks + ' 白' + whites);

    // ② 开局不能已经是五连
    let hasFive = false;
    for (let i = 0; i < C.CELLS; i++) if (eng.isFive(i)) { hasFive = true; break; }
    ok(!hasFive, tag + ' 题面不存在既成五连');

    // ③ 必须真的有连冲解
    const first = Kill.vcf(eng, BLACK, 14);
    ok(first >= 0, tag + ' 存在连冲必胜解', 'Kill.vcf=' + first);
    if (first < 0) continue;

    // ④ 顺解走一遍：每手必须是冲四，深度必须与题面一致
    const b = toEngine(pz.board);
    const buf = new Int32Array(8);
    let depth = 0, bad = '';
    for (let d = 0; d < 20; d++) {
        const m = Kill.vcf(b, BLACK, 14);
        if (m < 0) { bad = '第' + (d + 1) + '手找不到连冲'; break; }
        b.place(m, BLACK);
        depth++;
        if (b.isFive(m)) break;
        const n = Kill.fivePoints(b, m, BLACK, buf);
        if (n === 0) { bad = '第' + (d + 1) + '手不是冲四'; break; }
        if (n >= 2) break;                 // 活四/双四，已经赢定
        b.place(buf[0], WHITE);
    }
    ok(!bad, tag + ' 每一手都是冲四', bad);
    eq(depth, pz.depth, tag + ' 实际深度与标注一致');
}

/* ================================================================== */
console.log('VCF 连冲练习 —— 状态机');
console.log('─'.repeat(52));

{
    const pz = VCF.PUZZLES[1];             // 两手的题，适合验证回合与撤销
    const s = VCF.create(1);

    // 提示点必须真的是冲四
    const h = s.hint();
    ok(!!h, 'hint() 返回一个点', JSON.stringify(h));
    if (h) {
        const b = toEngine(s.board2d);
        const i = C.idx(h.x, h.y);
        b.place(i, BLACK);
        const n = Kill.fivePoints(b, i, BLACK, new Int32Array(8));
        ok(n >= 1, 'hint() 给的点确实能形成四', nm(h) + ' 五点数=' + n);
    }

    // 非冲四：必须拒绝，且棋子不留在盘上
    const before = JSON.stringify(s.board2d);
    const r0 = s.play(0, 0);
    eq(r0.code, 'NOT_FOUR', '非冲四点被判 NOT_FOUR');
    eq(JSON.stringify(s.board2d), before, '判错后棋盘原样恢复');
    eq(s.steps, 0, '判错不计步数');

    // 正确首手：冲四成立 + 对手自动应手
    const r1 = s.play(h.x, h.y);
    ok(r1.code === 'FOUR' || r1.code === 'DOUBLE' || r1.code === 'WIN', '正解首手被接受', r1.code);
    if (r1.code === 'FOUR') {
        ok(!!r1.reply, '冲四后对手自动应手', JSON.stringify(r1.reply));
        eq(s.board2d[r1.reply.y][r1.reply.x], WHITE, '对手应手落在棋盘上（白子）');
        eq(r1.dead, false, '这一手之后仍有连冲');
    }
    eq(s.steps, 1, '正解计 1 步');

    // 撤销一个回合：棋盘与步数都要还原
    const snapshot = JSON.stringify(s.board2d);
    s.undo();
    eq(s.steps, 0, '撤销后步数归零');
    eq(JSON.stringify(s.board2d), before, '撤销后棋盘还原');

    // 一路照提示走到底，必须通关
    const s2 = VCF.create(1);
    let guard = 0, solved = false;
    while (guard++ < 20) {
        if (s2.state === 'solved') { solved = true; break; }
        if (s2.state === 'failed') break;
        const hh = s2.hint();
        if (!hh) break;
        const r = s2.play(hh.x, hh.y);
        if (r.code === 'WIN' || r.code === 'DOUBLE') { solved = true; break; }
        if (r.code !== 'FOUR') break;
    }
    ok(solved, '照提示一路走可以通关');
    eq(s2.state, 'solved', '通关后状态为 solved');
    ok(s2.steps >= pz.depth, '通关步数不少于题目标注深度', s2.steps + ' / ' + pz.depth);
}

{
    // 每道题都能用「照提示走」通关（防止某题数据坏了只能靠运气）
    let allSolved = true, badId = '';
    for (let k = 0; k < VCF.PUZZLES.length; k++) {
        const s = VCF.create(k);
        let guard = 0;
        while (guard++ < 24 && s.state === 'playing') {
            const h = s.hint();
            if (!h) break;
            const r = s.play(h.x, h.y);
            if (r.code !== 'FOUR' && r.code !== 'WIN' && r.code !== 'DOUBLE') break;
        }
        if (s.state !== 'solved') { allSolved = false; badId = VCF.PUZZLES[k].id; break; }
    }
    ok(allSolved, '全部题目均可照提示通关', badId);
}

{
    // 参考线：长度必须与深度吻合，且首手是冲四
    const line = VCF.solutionOf(1);
    ok(Array.isArray(line) && line.length >= 2, '参考线至少 2 手', line.length);
    eq(line.length, VCF.PUZZLES[1].depth, '参考线长度等于标注深度');
    ok(line[0] && line[0].black, '参考线首手有黑方坐标');
}

{
    // 成绩记录：只保留更快的
    VCF.clearProgress();
    VCF.record('vcf-02', 9000, 2);
    VCF.record('vcf-02', 12000, 2);
    eq(VCF.getRecord('vcf-02').ms, 9000, '更慢的成绩不覆盖记录');
    VCF.record('vcf-02', 5000, 2);
    eq(VCF.getRecord('vcf-02').ms, 5000, '更快的成绩会覆盖记录');
    eq(VCF.solvedCount(), 1, '已解数量统计正确');
    VCF.clearProgress();
}

/* ================================================================== */
console.log('\n' + '─'.repeat(52));
if (fail === 0) {
    console.log('✓ 全部通过：' + pass + ' 项');
    process.exit(0);
} else {
    console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
}
