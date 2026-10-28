/**
 * QA 独立行为验证（不信任工程师自带测试）：
 * 在 Node 里加载引擎 + analysis.js，直接调 GMK.Analysis 的 4 个方法。
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const E = path.join(ROOT, 'js', 'engine');

require(path.join(E, 'constants.js'));
const Board = require(path.join(E, 'board.js'));
require(path.join(E, 'evaluator.js'));
require(path.join(E, 'search.js'));
require(path.join(E, 'kill.js'));
require(path.join(E, 'forbidden.js'));
const EngineAI = require(path.join(E, 'gomoku-ai.js'));
const Analysis = require(path.join(ROOT, 'js', 'app', 'analysis.js'));

const C = globalThis.GMK.C;
let pass = 0, fail = 0;
const out = [];
function check(name, cond, extra) {
    if (cond) { pass++; out.push('  ✓ ' + name); }
    else { fail++; out.push('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

// ---- 15×15 局面：黑中盘活三，白在另一侧 ----
function makeBoard2D() {
    const b = Array.from({ length: 15 }, () => new Array(15).fill(0));
    b[7][4] = 1; b[7][5] = 1; b[7][6] = 1;          // 黑活三（行8 第5~7列）
    b[3][10] = 2; b[3][11] = 2;                       // 白两连
    return b;
}
const board = makeBoard2D();

// 方法齐全性
check('Analysis 暴露 5 个成员', ['advantage','threatPoint','evaluate','scanOpponentThreat','opp'].every(k => typeof Analysis[k] === 'function'),
    JSON.stringify(Object.keys(Analysis)));

// ---- evaluate ----
const ev = Analysis.evaluate(board, 1, { timeMs: 300 });
check('evaluate 返回 {best, ranking}', ev && ev.best && Array.isArray(ev.ranking));
check('best 字段齐全 {x,y,score,depth,nodes,timeMs,pv}', ev && ev.best &&
    ['x','y','score','depth','nodes','timeMs','pv'].every(k => k in ev.best),
    ev && ev.best ? JSON.stringify(Object.keys(ev.best)) : '无 best');
check('best 坐标在盘内或哨兵(-1,-1)', ev && ((ev.best.x === -1 && ev.best.y === -1) ||
    (ev.best.x >= 0 && ev.best.x < 15 && ev.best.y >= 0 && ev.best.y < 15)),
    JSON.stringify(ev && ev.best));
check('ranking >= 3 条', ev && ev.ranking.length >= 3, 'ranking=' + (ev && ev.ranking.length));
check('ranking 每条含 {x,y,score,source,pv}', ev && ev.ranking.length && ev.ranking.every(r =>
    ['x','y','score','source','pv'].every(k => k in r)),
    ev && ev.ranking[0] ? JSON.stringify(Object.keys(ev.ranking[0])) : '空');
check('ranking 首条 = best（引擎最佳点优先）', ev && ev.ranking[0] && ev.ranking[0].x === ev.best.x && ev.ranking[0].y === ev.best.y,
    'best=' + JSON.stringify(ev && ev.best) + ' rank[0]=' + JSON.stringify(ev && ev.ranking[0]));

// ---- threatPoint / scanOpponentThreat ----
// 让白（2）有一处「一步成五」：白活四放在盘上角，确保两端进入 nearbyCandidates 前 30
// （候选按填充索引行优先排列，SCAN_MAX=30 截断 —— 这是已知的源码局限，见 QA 报告）
function boardWhiteFour() {
    const b = makeBoard2D();
    b[0][1] = 2; b[0][2] = 2; b[0][3] = 2; b[0][4] = 2;   // 白活四：威胁点 (0,0) 与 (5,0)
    return b;
}
const wp = boardWhiteFour();
const th = Analysis.threatPoint(wp, 2, 5);
check('threatPoint 返回列表（对方活四威胁）', Array.isArray(th) && th.length >= 1, JSON.stringify(th));
check('threatPoint 命中活四两端之一 (0,0)/(5,0)',
    th.some(t => (t.x === 0 && t.y === 0) || (t.x === 5 && t.y === 0)), JSON.stringify(th));
check('threatPoint 条目含 {x,y,score}', th.length && th.every(t => t.x !== undefined && t.y !== undefined && typeof t.score === 'number'));

// KNOWN-BUG（T1）：候选截断 30 个 + 填充索引行优先排序，
// 中/下半盘散子局面下真正威胁点排在第 30 名之后会被漏扫。
// 设计 PRD P0 要求「对手成五点」必须高亮，此断言目前预期为 FAIL（工程师修复后应转 PASS）。
{
    const b2 = makeBoard2D();
    b2[11][4] = 2; b2[11][5] = 2; b2[11][6] = 2; b2[11][7] = 2; // 白活四在下半盘，威胁点 (3,11)/(8,11)
    const th2 = Analysis.threatPoint(b2, 2, 5);
    check('BUG复现：下半盘活四威胁点必须被扫出（当前 SCAN_MAX=30 截断导致漏扫，修复后应通过）',
        th2.some(t => (t.x === 3 && t.y === 11) || (t.x === 8 && t.y === 11)),
        '实际返回 ' + JSON.stringify(th2));
}

const st = Analysis.scanOpponentThreat(wp, 2);
check('scanOpponentThreat 有威胁时返回 {x,y}', st && st.x !== undefined && st.y !== undefined, JSON.stringify(st));

// 无威胁局面（空盘）
const empty = Array.from({ length: 15 }, () => new Array(15).fill(0));
const stNone = Analysis.scanOpponentThreat(empty, 2);
check('scanOpponentThreat 无威胁时返回 null', stNone === null, JSON.stringify(stNone));

// ---- advantage ----
const adv = Analysis.advantage(board, 1, 200);
check('advantage 返回 {side, score, depth}', adv && typeof adv.side === 'string' && typeof adv.score === 'number' && typeof adv.depth === 'number',
    JSON.stringify(adv));
check('advantage.side ∈ black/white/equal', adv && ['black','white','equal'].includes(adv.side), JSON.stringify(adv));
// 黑活三局面，黑应领先或均势（不应白领先）
check('黑活三局面 advantage 不为白领先', adv && adv.side !== 'white', JSON.stringify(adv));

// 白劣势局面（白活四威胁）优势条应偏白或均势
const advW = Analysis.advantage(boardWhiteFour(), 2, 200);
check('白活四局面对白视角 advantage 合理', advW && ['black','white','equal'].includes(advW.side), JSON.stringify(advW));

// 边界：player 缺省
const advDef = Analysis.advantage(board);
check('advantage 缺省 player 不抛异常', advDef && ['black','white','equal'].includes(advDef.side));

// 边界：全空盘
const advEmpty = Analysis.advantage(empty, 1, 200);
check('advantage 空盘返回 equal', advEmpty && advEmpty.side === 'equal', JSON.stringify(advEmpty));

console.log('\n=== QA 行为验证（analysis.js）===');
console.log(out.join('\n'));
console.log(`\n→ ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
