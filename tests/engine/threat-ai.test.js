/**
 * ThreatAI（TSS 前置 AI 包装层）单元测试
 *
 * 核心契约：
 *   1. 命中：TSS 证明必胜 → 直接落子，source='vct'，info 字段齐全（含填充索引 move）
 *   2. 未命中 / 预算关 / 终局 → 原样委托内层，getLastInfo 透传内层诊断
 *   3. 禁手安全：黑棋的 TSS 点若为 RIF 禁手 → 委托内层（TSS 不懂禁手）
 *   4. 链式：setOverride 透传内层（App 持外层引用可调 TunableAI 参数）
 *   5. 双色：白棋视角同样可命中（info.player 正确）
 *
 * 运行：node tests/engine/threat-ai.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
require(path.join(ENGINE, 'kill.js'));
require(path.join(ENGINE, 'forbidden.js'));
require(path.join(ENGINE, 'gomoku-ai.js'));
require(path.join(ENGINE, 'tss.js'));
const ThreatAI = require(path.join(ROOT, 'js', 'app', 'threat-ai.js'));
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

/** 假内层：返回固定点并统计委托次数 */
function fakeInner(move) {
    let called = 0;
    return {
        getMove() { called++; return move || { x: 7, y: 7 }; },
        getLastInfo() { return called ? { source: 'search', move: -1 } : null; },
        sync() {},
        called() { return called; }
    };
}

/** 双活三测试局面（黑 (6,7)(8,7)(7,6)(7,8)，TSS 在预算内必有解） */
function doubleThreeGame(currentPlayer) {
    return {
        gameStatus: 'playing',
        currentPlayer: currentPlayer || 1,
        getBoardState() {
            const g = Array.from({ length: 15 }, () => new Array(15).fill(0));
            g[7][6] = currentPlayer || 1;
            g[7][8] = currentPlayer || 1;
            g[6][7] = currentPlayer || 1;
            g[8][7] = currentPlayer || 1;
            return g;
        }
    };
}

/* ---------------- 1. 命中：source='vct' ---------------- */

{
    const inner = fakeInner();
    // 双活三首解 ~17k 节点 / ~630ms,贴着 HARD 400ms 死线会间歇超时 —— 显式放宽
    const w = ThreatAI.createWrapper(inner, {
        game: doubleThreeGame(1),
        budgets: { HARD: { nodeBudget: 300000, timeMs: 3000 } }
    });
    const mv = w.getMove('HARD');
    ok(mv && typeof mv.x === 'number' && mv.x >= 0, '命中时返回合法点', JSON.stringify(mv));
    const info = w.getLastInfo();
    ok(!!info, '命中后 getLastInfo 有值');
    if (info) {
        eq(info.source, 'vct', 'source 标记为 vct');
        eq(info.player, 1, 'info.player 为行棋方');
        eq(info.level, 'HARD', 'info.level 镜像难度');
        ok(info.move >= 0 && C.inBoard(info.move), 'info.move 为合法填充索引', String(info.move));
        ok(info.nodes > 0 && info.timeMs >= 0, '诊断字段齐全', JSON.stringify({ nodes: info.nodes, timeMs: info.timeMs }));
        ok(C.xOf(info.move) === mv.x && C.yOf(info.move) === mv.y, 'move 索引与返回点一致');
    }
    eq(inner.called(), 0, '命中时不委托内层');
}

/* ---------------- 2. 未命中 / 委托 ---------------- */

{
    // 空盘 NORMAL：无强制胜 → 委托
    const inner = fakeInner();
    const w = ThreatAI.createWrapper(inner, {
        game: { gameStatus: 'playing', currentPlayer: 1, getBoardState: () => Array.from({ length: 15 }, () => new Array(15).fill(0)) }
    });
    const mv = w.getMove('NORMAL');
    eq(inner.called(), 1, '未命中委托内层');
    eq(mv.x, 7, '返回内层的着法');
    eq(w.getLastInfo() && w.getLastInfo().source, 'search', '未命中透传内层诊断');

    // BEGINNER 预算 0：即使局面可解也委托（新手保留失误空间）
    const inner2 = fakeInner();
    const w2 = ThreatAI.createWrapper(inner2, { game: doubleThreeGame(1) });
    w2.getMove('BEGINNER');
    eq(inner2.called(), 1, 'BEGINNER 永远委托');

    // 终局守卫
    const inner3 = fakeInner();
    const w3 = ThreatAI.createWrapper(inner3, {
        game: Object.assign(doubleThreeGame(1), { gameStatus: 'finished' })
    });
    w3.getMove('HELL');
    eq(inner3.called(), 1, '终局不跑 TSS 直接委托');
}

/* ---------------- 3. 禁手安全：黑棋 TSS 点为三三禁手 → 回退 ---------------- */

{
    // mock：TSS 强制返回双活三交点 (7,7) —— 对黑是三三禁手
    const realSolve = GMK.TSS.solve;
    GMK.TSS.solve = () => ({ move: C.idx(7, 7), depth: 2, nodes: 10 });
    try {
        const inner = fakeInner();
        const w = ThreatAI.createWrapper(inner, { game: doubleThreeGame(1) });
        const mv = w.getMove('HARD');
        eq(inner.called(), 1, '黑棋禁手点回退内层');
        eq(mv.x, 7, '回退后走内层着法');
        eq(w.getLastInfo() && w.getLastInfo().source, 'search', '回退后透传内层诊断');
        // 白棋同一个点不是禁手 → 应命中（mock 直接放行）
        const innerW = fakeInner();
        const wW = ThreatAI.createWrapper(innerW, { game: doubleThreeGame(2) });
        const mvW = wW.getMove('HARD');
        eq(innerW.called(), 0, '白棋同点不禁手 → 命中');
        ok(mvW.x === 7 && mvW.y === 7, '白棋按 TSS 点落子', JSON.stringify(mvW));
    } finally {
        GMK.TSS.solve = realSolve;
    }
}

/* ---------------- 4. 链式：setOverride 透传 ---------------- */

{
    const inner = fakeInner();
    inner.setOverride = function (v) { return 'override-' + v; };
    const w = ThreatAI.createWrapper(inner, { game: doubleThreeGame(1) });
    eq(w.setOverride(42), 'override-42', 'setOverride 透传内层');
    const innerPlain = fakeInner();
    const wPlain = ThreatAI.createWrapper(innerPlain, { game: doubleThreeGame(1) });
    eq(wPlain.setOverride, undefined, '内层无 setOverride 时不暴露该键');
}

/* ---------------- 5. 双色：白棋视角 ---------------- */

{
    const inner = fakeInner();
    const w = ThreatAI.createWrapper(inner, {
        game: doubleThreeGame(2),
        budgets: { HELL: { nodeBudget: 300000, timeMs: 3000 } }
    });
    const mv = w.getMove('HELL');
    ok(mv && typeof mv.x === 'number', '白棋视角命中', JSON.stringify(mv));
    eq(w.getLastInfo().player, 2, 'info.player = 白');
    eq(inner.called(), 0, '白棋命中不委托');
}
/* ---------------- 6. 锁线跟随 ---------------- */

{
    // 可变棋盘的 game 桩（局面用真实 VCT 题 vct-01 换色 → 白方攻杀，避开黑禁手分支）
    const boardState = VCF.PUZZLES[VCF.indexOf('vct-01')].board.map((r) => r.slice())
        .map((r) => r.map((v) => (v === 1 ? 2 : v === 2 ? 1 : 0)));
    const game = {
        gameStatus: 'playing',
        currentPlayer: 2,
        getBoardState() { return boardState; }
    };
    const realSolve = GMK.TSS.solve;
    let solveCalls = 0;
    GMK.TSS.solve = function (b, p, opts) { solveCalls++; return realSolve(b, p, opts); };
    try {
        // vct-01 首解 ~67k 节点，默认 HARD 预算(40k)命中不了 —— 用大预算验证锁线机制
        const inner = fakeInner();
        const w = ThreatAI.createWrapper(inner, {
            game,
            budgets: { HARD: { nodeBudget: 600000, timeMs: 8000 } }
        });
        const mv1 = w.getMove('HARD');   // 白行棋
        ok(mv1 && typeof mv1.x === 'number', '锁线:首着命中', JSON.stringify(mv1));
        const lock = w.__locks[2];   // 白方的锁在 2 号槽
        ok(!!lock && lock.plan.length >= 2, '命中后建立杀线计划', JSON.stringify(lock && lock.plan.length));

        // 对手按预期防守（plan[0].expectedDefender = 对首着的预期应点）→ 第二手零求解
        const ei0 = lock.plan[0].expectedDefender;
        ok(ei0 >= 0 && boardState[C.yOf(ei0)][C.xOf(ei0)] === 0, '计划带预期防手点');
        // 真实对局里游戏会先后摆上攻方 mv1 与防守应手（子数守卫依赖这两手都落实）
        if (mv1) boardState[mv1.y][mv1.x] = 2;
        if (ei0 >= 0) boardState[C.yOf(ei0)][C.xOf(ei0)] = 1;
        solveCalls = 0;
        const mv2 = w.getMove('HARD');
        eq(solveCalls, 0, '按预期防守时第二手零求解');
        const step1 = lock.plan[1];
        if (step1) {
            ok(mv2 && mv2.x === C.xOf(step1.move) && mv2.y === C.yOf(step1.move),
                '第二手正是计划着法', JSON.stringify(mv2));
        }

        // 对手偏离 → 解锁重新求解（局面仍必胜，应再命中）
        const boardState2 = VCF.PUZZLES[VCF.indexOf('vct-01')].board.map((r) => r.slice());
        const game2 = { gameStatus: 'playing', currentPlayer: 1, getBoardState: () => boardState2 };
        const w2 = ThreatAI.createWrapper(fakeInner(), {
            game: game2,
            budgets: { HARD: { nodeBudget: 600000, timeMs: 8000 } }
        });
        w2.getMove('HARD');
        const lock2 = w2.__locks[1];
        const wrong = lock2.plan[0].expectedDefender === C.idx(5, 4) ? C.idx(9, 4) : C.idx(5, 4);
        boardState2[C.yOf(wrong)][C.xOf(wrong)] = 2;
        solveCalls = 0;
        const mv3 = w2.getMove('HARD');
        ok(solveCalls >= 1, '偏离后解锁重新求解');
        ok(mv3 && typeof mv3.x === 'number', '偏离后仍给出着法', JSON.stringify(mv3));

        // 陈旧守卫:换新对局(空盘)后,旧计划立即失效
        const boardState3 = Array.from({ length: 15 }, () => new Array(15).fill(0));
        const game3 = { gameStatus: 'playing', currentPlayer: 1, getBoardState: () => boardState3 };
        const w3 = ThreatAI.createWrapper(fakeInner(), { game: game3 });
        w3.getMove('HARD');   // 空盘不命中,仅铺垫
        w3.__locks[1] = { plan: [{ move: C.idx(7, 7), expectedDefender: -1 }], idx: 1, player: 1, stonesAtLock: 1 };
        solveCalls = 0;
        w3.getMove('HARD');
        eq(w3.__locks[1], null, '子数守卫:空盘使旧锁立即失效');
    } finally {
        GMK.TSS.solve = realSolve;
    }
}

console.log('\n' + '─'.repeat(52));
if (fail === 0) {
    console.log('✓ 全部通过：' + pass + ' 项');
    process.exit(0);
} else {
    console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
    failures.forEach((f) => console.log('   · ' + f));
    process.exit(1);
}
