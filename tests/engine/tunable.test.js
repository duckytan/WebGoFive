/**
 * P2 单元测试：TunableAI（参数清洗 + AI 包装透传）+ Analysis.openingRecommendation（开局定式推荐）
 *
 * 运行：node tests/engine/tunable.test.js
 * 不依赖任何第三方测试框架，失败时以非 0 退出码结束（可直接接 CI）。
 * 全部为 DOM 无依赖的纯逻辑测试（PRD §5.4）。
 */

'use strict';

const path = require('path');
const ENGINE = path.join(__dirname, '..', '..', 'js', 'engine');
const APP = path.join(__dirname, '..', '..', 'js', 'app');

require(path.join(ENGINE, 'constants.js'));
require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
require(path.join(ENGINE, 'kill.js'));
require(path.join(ENGINE, 'forbidden.js'));
require(path.join(ENGINE, 'gomoku-ai.js'));
const TunableAI = require(path.join(APP, 'tunable-ai.js'));
const Analysis = require(path.join(APP, 'analysis.js'));
const GMK = globalThis.GMK;
const C = GMK.C;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra !== undefined ? '  →  ' + extra : ''));
    console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + extra : ''));
}

function eq(actual, expected, name) {
    ok(actual === expected, name, `期望 ${expected}，实际 ${actual}`);
}

/** 15×15 二维空盘 */
function empty2d() {
    return Array.from({ length: C.SIZE }, () => new Array(C.SIZE).fill(0));
}

/* ================================================================== *
 * 1. sanitize：参数清洗
 * ================================================================== */
{
    const d = C.LEVELS.HELL;
    let s = TunableAI.sanitize({});
    eq(s.timeMs, d.timeMs, 'sanitize 空对象回退引擎 HELL 默认 timeMs');
    eq(s.depth, d.depth, 'sanitize 空对象回退引擎 HELL 默认 depth');
    eq(s.candidates, d.candidates, 'sanitize 空对象回退引擎 HELL 默认 candidates');

    eq(TunableAI.sanitize({ timeMs: 50 }).timeMs, TunableAI.LIMITS.timeMs.min, '低于下限的时间夹到 100ms');
    eq(TunableAI.sanitize({ timeMs: 999999 }).timeMs, TunableAI.LIMITS.timeMs.max, '超上限的时间夹到 10000ms');
    eq(TunableAI.sanitize({ depth: 0 }).depth, TunableAI.LIMITS.depth.min, '深度 0 夹到下限 1');
    eq(TunableAI.sanitize({ depth: 999 }).depth, TunableAI.LIMITS.depth.max, '深度过大夹到上限 24');
    eq(TunableAI.sanitize({ candidates: 1 }).candidates, TunableAI.LIMITS.candidates.min, '候选数下限 4');
    eq(TunableAI.sanitize({ candidates: 1000 }).candidates, TunableAI.LIMITS.candidates.max, '候选数上限 64');

    s = TunableAI.sanitize({ timeMs: 'abc', depth: null, candidates: undefined });
    eq(s.timeMs, d.timeMs, '非数值 timeMs 回退默认');
    eq(s.depth, d.depth, 'null depth 回退默认');
    eq(s.candidates, d.candidates, 'undefined candidates 回退默认');

    eq(TunableAI.sanitize({ timeMs: 1234.6 }).timeMs, 1235, '小数时间取整');

    ok(TunableAI.equalsDefault(TunableAI.sanitize({})), '空清洗结果等于默认');
    ok(!TunableAI.equalsDefault(TunableAI.sanitize({ timeMs: 500 })), '改过时间的清洗结果不等于默认');
}

/* ================================================================== *
 * 2. createWrapper：假引擎验证委托 / 透传 / 守卫
 * ================================================================== */
function fakeEngine(game) {
    return {
        game: game,
        calls: [],
        getMove(difficulty, override) { this.calls.push(['getMove', difficulty, override]); return { x: 1, y: 2 }; },
        getBestMove(grid, p, opts) { this.calls.push(['getBestMove', grid, p, opts]); return { x: 3, y: 4 }; },
        getLastInfo() { return { marker: 'engine-info' }; },
        sync() { this.calls.push(['sync']); }
    };
}

/** 假 game：GomokuAI 契约只需 board / currentPlayer / gameStatus / getBoardState */
function fakeGame() {
    const g = { board: empty2d(), currentPlayer: 1, gameStatus: 'playing' };
    g.getBoardState = function () { return this.board; };
    return g;
}

{
    const game = fakeGame();
    const eng = fakeEngine(game);
    const w = TunableAI.createWrapper(eng);

    // 无 override：任何难度都原样委托 getMove，不碰 getBestMove
    w.getMove('HARD');
    eq(eng.calls.length, 1, '无 override 时只调一次引擎');
    eq(eng.calls[0][0], 'getMove', '无 override 委托 getMove');
    eq(eng.calls[0][1], 'HARD', '难度原样传递');

    // HELL + override：走 getBestMove 公开契约透传
    const eff = w.setOverride({ timeMs: 800, depth: 6, candidates: 12 });
    ok(eff && eff.timeMs === 800 && eff.depth === 6 && eff.candidates === 12, 'setOverride 返回生效参数', JSON.stringify(eff));
    w.getMove('HELL');
    const call = eng.calls[eng.calls.length - 1];
    eq(call[0], 'getBestMove', 'HELL + override 走 getBestMove');
    eq(call[1], game.board, 'getBestMove 收到当前盘面');
    eq(call[3].difficulty, 'HELL', 'getBestMove 收到难度');
    eq(call[3].timeMs, 800, 'getBestMove 透传 timeMs');
    eq(call[3].depth, 6, 'getBestMove 透传 depth');
    eq(call[3].candidates, 12, 'getBestMove 透传 candidates');
    ok(w.getMove('HARD') !== undefined && eng.calls[eng.calls.length - 1][0] === 'getMove',
        'override 不影响非 HELL 难度（仍委托 getMove）');

    // getLastInfo / sync 委托
    eq(w.getLastInfo().marker, 'engine-info', 'getLastInfo 委托引擎');
    w.sync();
    eq(eng.calls[eng.calls.length - 1][0], 'sync', 'sync 委托引擎');

    // 终局守卫：getBestMove 内部会换临时 game 绕过终局判断，包装层必须先拦
    eng.calls.length = 0;
    game.gameStatus = 'finished';
    eq(w.getMove('HELL'), null, '终局时 getMove 返回 null');
    eq(eng.calls.length, 0, '终局时不再触达引擎');
    game.gameStatus = 'playing';

    // setOverride(null) 清空；等于默认也自动清空
    w.setOverride(null);
    eng.calls.length = 0;
    w.getMove('HELL');
    eq(eng.calls[eng.calls.length - 1][0], 'getMove', '清除 override 后 HELL 回到默认委托');
    w.setOverride(C.LEVELS.HELL);
    eq(w.override, null, '参数等于引擎默认时自动清空 override');
}

/* ================================================================== *
 * 3. createWrapper × 真实引擎：端到端透传（真实搜索，参数压到最小档）
 * ================================================================== */
{
    const game = fakeGame();
    // 空盘没有近子候选点，搜索直接返回 depth 0 —— 摆两子让搜索真正跑起来
    game.board[7][7] = 1;
    game.board[7][8] = 2;
    const eng = new GMK.EngineAI(game);
    const w = TunableAI.createWrapper(eng);
    w.setOverride({ timeMs: 400, depth: 4, candidates: 8 });

    const mv = w.getMove('HELL');
    ok(mv && mv.x >= 0 && mv.x < C.SIZE && mv.y >= 0 && mv.y < C.SIZE, '真实引擎 HELL 透传返回合法坐标', JSON.stringify(mv));
    const info = w.getLastInfo();
    ok(info && info.difficulty === 'HELL', '诊断 difficulty=HELL', info && info.difficulty);
    ok(info && info.depth >= 1 && info.depth <= 4, '实际深度不超自定义上限', info && ('depth=' + info.depth));
    ok(info && info.move >= 0 && C.inBoard(info.move), '诊断 move 为合法填充索引');
    eq(game.board[mv.y][mv.x], 0, '透传搜索不在真实盘面上留子');

    // 非 HELL：即便有 override 也走默认路径
    const mv2 = w.getMove('NORMAL');
    ok(mv2 && typeof mv2.x === 'number', 'NORMAL 难度正常返回');
}

/* ================================================================== *
 * 4. Analysis.openingRecommendation：开局定式推荐
 * ================================================================== */
{
    // 空盘 → 天元（黑 / 白都一样）
    const r0b = Analysis.openingRecommendation(empty2d(), C.BLACK);
    ok(r0b && r0b.x === 7 && r0b.y === 7, '空盘黑方推荐天元 (7,7)', JSON.stringify(r0b));
    const r0w = Analysis.openingRecommendation(empty2d(), C.WHITE);
    ok(r0w && r0w.x === 7 && r0w.y === 7, '空盘白方推荐天元 (7,7)', JSON.stringify(r0w));

    // 1 子：推荐空点且不推荐已占点
    const b1 = empty2d();
    b1[3][3] = C.BLACK;
    const r1 = Analysis.openingRecommendation(b1, C.BLACK);
    ok(r1 && r1.stones === 1, '1 子局面仍在开局窗口', JSON.stringify(r1));
    ok(r1 && !(r1.x === 3 && r1.y === 3), '绝不推荐已占点');
    ok(r1 && b1[r1.y][r1.x] === 0, '推荐点为空点');

    // 3 子仍在窗口，4 子出窗
    const b3 = empty2d();
    b3[7][7] = C.BLACK; b3[7][8] = C.WHITE; b3[8][7] = C.BLACK;
    ok(Analysis.openingRecommendation(b3, C.WHITE) !== null, '3 子仍在开局窗口');
    const b4 = empty2d();
    b4[7][7] = C.BLACK; b4[7][8] = C.WHITE; b4[8][7] = C.BLACK; b4[8][8] = C.WHITE;
    eq(Analysis.openingRecommendation(b4, C.BLACK), null, '4 子后退出开局窗口');

    // 窗口可通过 opts.window 调整
    eq(Analysis.openingRecommendation(b4, C.BLACK, { window: 10 }) !== null, true, '扩大窗口后 4 子仍可推荐');
    eq(Analysis.openingRecommendation(b3, C.WHITE, { window: 3 }), null, '缩小窗口后 3 子即出窗');

    // 对称盘面同分时中心性破平：黑在 (0,0) 一子，(1,1) 与 (0,1)/(1,0) 同分时应取更靠中心的
    const bc = empty2d();
    bc[0][0] = C.BLACK;
    const rc = Analysis.openingRecommendation(bc, C.WHITE);
    ok(rc && rc.x >= 0 && rc.y >= 0, '角落 1 子局面可推荐', JSON.stringify(rc));
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
