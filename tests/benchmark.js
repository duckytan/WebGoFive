/**
 * 引擎性能基准
 *
 * 运行：node tests/benchmark.js [毫秒数]
 *
 * 输出每个测试局面的到达深度、节点数、NPS、置换表命中率、主变例。
 * 这些数字是判断「引擎够不够快」的唯一依据 —— 不要凭感觉调参。
 */

'use strict';

const path = require('path');
const ENGINE = path.join(__dirname, '..', 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
const Ev = require(path.join(ENGINE, 'evaluator.js'));
const Search = require(path.join(ENGINE, 'search.js'));
const C = globalThis.GMK.C;

const TIME_MS = parseInt(process.argv[2], 10) || 1000;

const name = (v) => v < 0 ? '--' : String.fromCharCode(65 + C.xOf(v)) + (C.yOf(v) + 1);

/** 按「黑、白、黑、白…」交替落子的着法序列构造棋盘 */
function fromMoves(moves) {
    const b = new Board();
    let side = C.BLACK;
    for (const [x, y] of moves) {
        b.place(C.idx(x, y), side);
        side = C.opp(side);
    }
    return b;
}

/**
 * 基准局面全部取自引擎自我对弈的真实棋局。
 *
 * 为什么要强调这一点：早先手写的中局/残局局面其实**一方已经必胜**，
 * 搜索在第 1 层就返回 ±9999999 并立刻收工，测出来是「1 层 / 30 个节点」——
 * 数字很漂亮，但完全没测到搜索能力。
 * 现在这四局的静态评估都在 ±2 万以内（远低于 500 万胜负阈值），
 * 搜索必须真的展开才有结果。
 */
const POSITIONS = [
    {
        label: '开局（2 子）',
        moves: [[7, 7], [6, 7]]
    },
    {
        label: '中局（10 子）',
        moves: [
            [7, 7], [6, 6], [7, 5], [7, 4], [8, 6],
            [6, 4], [9, 5], [10, 4], [8, 4], [6, 5]
        ]
    },
    {
        label: '中局（16 子，互相纠缠）',
        moves: [
            [7, 7], [6, 6], [7, 5], [7, 4], [8, 6],
            [6, 4], [9, 5], [10, 4], [8, 4], [6, 5],
            [6, 3], [5, 4], [8, 3], [6, 8], [6, 7], [8, 7]
        ]
    },
    {
        label: '中局（24 子）',
        moves: [
            [7, 7], [6, 6], [7, 5], [7, 4], [8, 6],
            [6, 4], [9, 5], [10, 4], [8, 4], [6, 5],
            [6, 3], [5, 4], [8, 3], [6, 8], [6, 7], [8, 7],
            [7, 6], [4, 4], [3, 4], [8, 5], [7, 8], [7, 9], [10, 6], [7, 3]
        ]
    },
    {
        label: '残局（34 子，已成杀）',
        moves: [
            [7, 7], [6, 6], [7, 5], [7, 4], [8, 6],
            [6, 4], [9, 5], [10, 4], [8, 4], [6, 5],
            [6, 3], [5, 4], [8, 3], [6, 8], [6, 7], [8, 7],
            [7, 6], [4, 4], [3, 4], [8, 5], [7, 8], [7, 9], [10, 6], [7, 3],
            [9, 6], [11, 6], [9, 7], [9, 4], [4, 5], [5, 6], [11, 7], [12, 8], [10, 8], [11, 9]
        ]
    }
];

console.log('='.repeat(78));
console.log('五子棋引擎性能基准   每局面思考 ' + TIME_MS + ' ms');
console.log('='.repeat(78));
console.log(
    '局面'.padEnd(24) +
    '深度'.padStart(5) + '节点'.padStart(9) + 'NPS'.padStart(9) +
    '耗时'.padStart(8) + 'TT命中'.padStart(8) + '  最佳着法'
);

const search = new Search({ ttBits: 18 });

for (const pos of POSITIONS) {
    const b = fromMoves(pos.moves);
    search.tt.clear();
    search.history.fill(0);

    const r = search.think(b, { timeMs: TIME_MS, depth: 20, candidates: 20 });
    const nps = Math.round(r.nodes / Math.max(1, r.timeMs) * 1000);

    console.log(
        pos.label.padEnd(24) +
        String(r.depth).padStart(5) +
        String(r.nodes).padStart(9) +
        String(nps).padStart(9) +
        (r.timeMs + 'ms').padStart(8) +
        ((r.ttHitRate * 100).toFixed(0) + '%').padStart(8) +
        '  ' + name(r.move) + '  (评分 ' + Math.round(r.score) + ')'
    );
    if (r.pv.length) {
        console.log(''.padEnd(24) + '主变例：' + r.pv.map(name).join(' → '));
    }
}

/* ------------------------------------------------------------------ *
 * 单项操作成本
 * ------------------------------------------------------------------ */
console.log('\n' + '-'.repeat(78));
console.log('单项操作成本（每项 20 万次）');

const b = fromMoves(POSITIONS[2].moves);
const N = 200000;

function bench(label, fn) {
    // 预热
    for (let i = 0; i < 20000; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn();
    const t1 = process.hrtime.bigint();
    const ns = Number(t1 - t0) / N;
    console.log('  ' + label.padEnd(28) + ns.toFixed(1).padStart(8) + ' ns/次');
}

const probe = C.idx(7, 9);
bench('pointValue(单点)', () => Ev.pointValue(b, probe, C.BLACK));
bench('evaluate(整盘)', () => Ev.evaluate(b, C.BLACK));

{
    const i = C.idx(0, 0);
    bench('place + unplace', () => {
        b.place(i, C.BLACK);
        b.unplace();
    });
}

console.log('\n提示：pointValue 应远小于 evaluate —— 点评估走预计算表，');
console.log('      局面评估要遍历双方 7 种棋型的组合判定。');
