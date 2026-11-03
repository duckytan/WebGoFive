/**
 * VCT 题库生成器
 *
 * 与 tools/gen-vcf.js 同思路：题目由求解器反向生成并验证，不手写答案。
 * 筛选条件（保证是「纯 VCT」而非换皮 VCF）：
 *   1. Kill.vcf 解不出（否则它只是 VCF 题的重复）
 *   2. TSS.solve 能解出，且**首着是活三**（VCT 的本体）
 *   3. 按会话判定逻辑走完全线（solve → 防手 → solve → … 直到成五/双威胁），
 *      全程每一步都必须仍在预算内可解 —— 与练习判定共用同一口径
 *
 * 输出 JSON 数组（id/level/depth/title/board 扁平串），人工审阅后粘进
 * js/app/vcf.js 的 VCT_RAW；tests/engine/tss.test.js 与 vcf-practice 侧的单测
 * 会逐题复验「VCF 解不出、VCT 解得出、走线深度与标注一致」。
 *
 * 用法：node tools/gen-vct.js [数量=8] [种子=42]
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js', 'engine', 'constants.js'));
require(path.join(ROOT, 'js', 'engine', 'board.js'));
require(path.join(ROOT, 'js', 'engine', 'evaluator.js'));
require(path.join(ROOT, 'js', 'engine', 'search.js'));
require(path.join(ROOT, 'js', 'engine', 'kill.js'));
require(path.join(ROOT, 'js', 'engine', 'forbidden.js'));
require(path.join(ROOT, 'js', 'engine', 'gomoku-ai.js'));
require(path.join(ROOT, 'js', 'engine', 'tss.js'));

const GMK = globalThis.GMK;
const C = GMK.C;
const TSS = GMK.TSS;
const Kill = GMK.Kill;

const COUNT = parseInt(process.argv[2], 10) || 8;
const SEED = parseInt(process.argv[3], 10) || 42;

/** 可复现的伪随机（mulberry32） */
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = rng(SEED);

const SOLVE_OPTS = { maxDepth: 8, nodeBudget: 80000 };
const buf = new Int32Array(8);
const shapeBuf = new Int8Array(4);

/** 按会话口径走线：solve → 防手 → solve → … 直到成五/双威胁。返回攻击手数组 */
function walk(board) {
    const line = [];
    for (let guard = 0; guard < 12; guard++) {
        const r = TSS.solve(board, C.BLACK, SOLVE_OPTS);
        if (!r || !C.inBoard(r.move)) return null;
        const m = r.move;
        if (GMK.Forbidden.isForbidden(board, m, C.BLACK)) return null;   // 走线中途不许踩禁手（v2.7.0 教训）
        board.place(m, C.BLACK);
        line.push(m);
        if (board.isFive(m)) return line;
        const n5 = Kill.fivePoints(board, m, C.BLACK, buf);
        if (n5 >= 2) return line;
        if (n5 === 1) {
            board.place(buf[0], C.WHITE);
        } else {
            const d = TSS.bestDefense(board, C.BLACK);
            board.place(d, C.WHITE);
        }
    }
    return null;
}

/** 首着必须是活三（纯 VCT 的判定） */
function firstMoveIsThree(board, move) {
    GMK.Evaluator.pointShapes(board, move, C.BLACK, shapeBuf);
    for (let d = 0; d < 4; d++) if (shapeBuf[d] === C.SHAPE.OPEN_THREE) return true;
    return false;
}

/** 白方是否已有「成四点」—— 有则保守求解器几乎必弃，廉价预筛掉 */
function whiteHasFourPoint(board) {
    const cells = board.cells;
    for (let y = 3; y < 12; y++) {
        for (let x = 3; x < 12; x++) {
            const i = C.idx(x, y);
            if (cells[i] !== C.EMPTY) continue;
            if (GMK.Evaluator.isWinningPoint(board, i, C.WHITE)) return true;
        }
    }
    return false;
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/**
 * 结构化构造：过枢纽点 (hx,hy) 的两条黑「断三/连三」+ 随机白子封端。
 * 相比纯随机撒子，命中「有 VCT 结构」的概率高几个量级。
 */
function structuredPosition() {
    const hx = 5 + Math.floor(rand() * 5);
    const hy = 5 + Math.floor(rand() * 5);
    const d1 = DIRS[Math.floor(rand() * DIRS.length)];
    let d2 = DIRS[Math.floor(rand() * DIRS.length)];
    if (d2 === d1) d2 = DIRS[(DIRS.indexOf(d1) + 1) % DIRS.length];

    const stones = [];
    const put = (x, y, p) => stones.push({ x: x, y: y, p: p });
    // 两条臂:枢纽 ± (1..2) 格,留出断口
    put(hx, hy, 0);   // 枢纽留空(首着候选)
    const arm = (dx, dy) => {
        const s1 = 1 + Math.floor(rand() * 2);            // 1 或 2 格外
        put(hx + dx * s1, hy + dy * s1, 1);
        if (rand() < 0.6) put(hx + dx * (s1 + 1), hy + dy * (s1 + 1), 1);
        if (rand() < 0.5) put(hx - dx * Math.floor(rand() * 2 + 1), hy - dy * Math.floor(rand() * 2 + 1), 1);
    };
    arm(d1[0], d1[1]);
    arm(d2[0], d2[1]);
    // 1~2 颗白子封端/干扰
    const whites = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < whites; k++) {
        const dx = Math.floor(rand() * 7) - 3;
        const dy = Math.floor(rand() * 7) - 3;
        if (dx === 0 && dy === 0) continue;
        put(hx + dx, hy + dy, 2);
    }
    // 去重 + 越界检查
    const seen = {};
    const board = new GMK.Board();
    for (const s of stones) {
        if (s.x < 1 || s.x > 13 || s.y < 1 || s.y > 13) return null;
        const i = C.idx(s.x, s.y);
        if (seen[i]) return null;
        seen[i] = true;
        if (s.p) board.place(i, s.p);
    }
    // 不能已有五连；黑子数必须 ≥ 白子数（黑先行）
    let blacks = 0, whites2 = 0;
    for (let i = 0; i < C.CELLS; i++) {
        if (board.cells[i] === C.BLACK) blacks++;
        if (board.cells[i] === C.WHITE) whites2++;
        if (board.cells[i] !== C.EMPTY && board.isFive(i)) return null;
    }
    if (blacks < whites2 || blacks < 3) return null;
    if (whiteHasFourPoint(board)) return null;
    return board;
}

function toFlat(board) {
    let s = '';
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) s += board.cells[C.idx(x, y)];
    return s;
}

const out = [];
const seen = new Set();
let attempts = 0;
while (out.length < COUNT && attempts++ < 20000) {
    const board = structuredPosition();
    if (!board) continue;
    // VCF 必须解不出（纯 VCT）
    if (Kill.vcf(board, C.BLACK, 12) >= 0) continue;
    const r = TSS.solve(board, C.BLACK, SOLVE_OPTS);
    if (!r || !firstMoveIsThree(board, r.move)) continue;
    // 题目必须落在对弈包装层的真实预算内（HARD=40k），否则 AI 实战命中不了
    if (r.nodes > 40000) continue;
    // RIF 禁手：黑棋解着若为禁手点，这题对黑不成立（v2.7.0 教训）
    if (GMK.Forbidden.isForbidden(board, r.move, C.BLACK)) continue;
    // ⚠ 先快照题面再走线：walk 会往盘上落子且不撤销，若先 walk 后快照，
    // 存下来的会是「走完杀线的残局」（v1 版生成器就栽在这上面）
    const flat = toFlat(board);
    if (seen.has(flat)) continue;
    const b2 = new GMK.Board();
    for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 15; x++) {
            const v = +flat[y * 15 + x] || 0;
            if (v) b2.place(C.idx(x, y), v);
        }
    }
    // 走线验证 + 深度（在克隆盘上）
    const line = walk(b2);
    if (!line || line.length < 2 || line.length > 4) continue;   // 攻击手数 2~4
    seen.add(flat);
    const depth = line.length;
    const level = depth >= 4 ? 3 : (depth >= 3 ? 2 : 1);
    out.push({
        level: level,
        depth: depth,
        board: flat,
        firstMove: '(' + C.xOf(r.move) + ',' + C.yOf(r.move) + ')',
        nodes: r.nodes
    });
}

console.log(JSON.stringify(out, null, 2));
console.error('生成 ' + out.length + ' 道（尝试 ' + attempts + ' 次）');
