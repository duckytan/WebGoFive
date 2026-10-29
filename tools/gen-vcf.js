/**
 * VCF 题库生成器（维护用工具，不参与运行时）
 *
 * 目的：不靠手写答案。随机撒黑/白子 → 用引擎的 Kill.vcf 判定是否真有连冲胜 →
 * 顺着必胜线走一遍，得到「黑方冲四序列」和深度 → 只保留深度 ≥ 2 的干净局面。
 *
 * 运行：node tools/gen-vcf.js [候选数] [seed]
 */
'use strict';
const path = require('path');
const ENGINE = path.join(__dirname, '..', 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
const Kill = require(path.join(ENGINE, 'kill.js'));

const C = globalThis.GMK.C;
const { BLACK, WHITE, EMPTY } = C;

/* ---------------- 可复现随机 ---------------- */
let seed = parseInt(process.argv[3], 10) || 20261029;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

/** 在 11×11 中心区撒点 */
function scatter(n, taken) {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < 500) {
        const x = ri(4, 12), y = ri(4, 12);
        const k = y * 15 + x;
        if (taken.has(k)) continue;
        taken.add(k); out.push([x, y]);
    }
    return out;
}

/** 顺着 VCF 必胜线走一遍，返回黑方冲四序列 */
function lineOf(board, maxDepth) {
    const seq = [];
    const buf = new Int32Array(8);
    for (let d = 0; d < maxDepth; d++) {
        const m = Kill.vcf(board, BLACK, 12);
        if (m < 0) return null;
        board.place(m, BLACK);
        seq.push({ x: C.xOf(m), y: C.yOf(m) });
        if (board.isFive(m)) return seq;
        const n = Kill.fivePoints(board, m, BLACK, buf);
        if (n === 0) return null;
        if (n >= 2) return seq;              // 活四/双四：下一手必成五
        board.place(buf[0], WHITE);          // 对手唯一应手
    }
    return null;
}

/** 局面是否「干净」：黑无现成四/五、白无四，避免白方反杀干扰题意 */
function clean(board) {
    const S = C.SHAPE;
    if (board.count(BLACK, S.FIVE) > 0) return false;
    if (board.count(BLACK, S.OPEN_FOUR) > 0 || board.count(BLACK, S.FOUR) > 0) return false;
    if (board.count(WHITE, S.FIVE) > 0 || board.count(WHITE, S.FOUR) > 0 || board.count(WHITE, S.OPEN_FOUR) > 0) return false;
    return true;
}

function to2D(board) {
    const g = [];
    for (let y = 0; y < 15; y++) {
        const row = [];
        for (let x = 0; x < 15; x++) row.push(board.cells[C.idx(x, y)]);
        g.push(row);
    }
    return g;
}

function name(p) { return String.fromCharCode(65 + p.x) + (p.y + 1); }

/* ---------------- 主循环 ---------------- */
const TARGET = parseInt(process.argv[2], 10) || 30000;
const found = [];
const seen = new Set();

for (let t = 0; t < TARGET; t++) {
    const taken = new Set();
    const nb = ri(6, 9), nw = nb - ri(0, 2);
    const blacks = scatter(nb, taken);
    const whites = scatter(nw, taken);

    const b = new Board();
    for (const [x, y] of blacks) b.place(C.idx(x, y), BLACK);
    for (const [x, y] of whites) b.place(C.idx(x, y), WHITE);

    if (!clean(b)) continue;
    // 子力均衡 + 局面集中，避免「黑 10 子打白 3 子」这种不像对局的排局
    let x0=99,y0=99,x1=-1,y1=-1;
    for (const [x,y] of blacks.concat(whites)) { if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
    if (x1-x0 > 8 || y1-y0 > 8) continue;
    if (Kill.vcf(b, BLACK, 14) < 0) continue;

    // 必须先快照：lineOf 会往棋盘上真实落子，走完再快照就把答案带进题面了
    const snapshot = to2D(b);
    const seq = lineOf(b, 14);
    if (!seq || seq.length < 2) continue;

    const key = JSON.stringify(snapshot);
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ board: snapshot, depth: seq.length, seq, stones: nb + nw });
}

found.sort((a, b) => b.depth - a.depth || a.stones - b.stones);
if (process.argv[4] === 'json') { console.log(JSON.stringify(found.slice(0, 10), null, 1)); process.exit(0); }
console.log('候选局面：' + found.length + '（扫描 ' + TARGET + ' 次）\n');
for (const f of found.slice(0, 25)) {
    console.log('depth=' + f.depth + '  子数=' + f.stones + '  线：' + f.seq.map(name).join(' → '));
    console.log('  黑：' + f.board.flatMap((row, y) => row.map((v, x) => v === BLACK ? name({ x, y }) : null).filter(Boolean)).join(' '));
    console.log('  白：' + f.board.flatMap((row, y) => row.map((v, x) => v === WHITE ? name({ x, y }) : null).filter(Boolean)).join(' '));
    console.log('');
}
