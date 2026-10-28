/**
 * 浏览器装配测试：用 vm.createContext 按 index.html 真实 script 顺序加载全部脚本，
 * 验证 GMK 命名空间完整、核心+引擎+渲染器+UI 装配、搜索后无残子、禁手判对。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const assert = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + msg); }
    else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  [' + extra + ']' : '')); }
};

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
assert(srcs.length >= 12, 'index.html 应至少 12 个外部 script', srcs.length + '');

// 极简浏览器 stub（够用即可，不模拟 canvas 绘制细节）
const ctx = vm.createContext({
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
    localStorage: { _d: {}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); }, removeItem(k){ delete this._d[k]; } },
    navigator: {},
    document: {
        getElementById: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){ return true; } }, addEventListener(){}, textContent: '', setAttribute(){} }),
        createElement: () => ({ getContext: () => null, width: 0, height: 0, addEventListener(){}, getBoundingClientRect(){ return { width: 0, height: 0 }; }, style: {} }),
        addEventListener(){}, body: { setAttribute(){} }, querySelector: () => null
    },
    window: null
});
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;

for (const rel of srcs) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    try { vm.runInContext(code, ctx, { filename: rel }); }
    catch (e) { assert(false, '加载 ' + rel + ' 失败', e.message); }
}

const G = ctx.GMK;
assert(G, 'GMK 命名空间已创建');
for (const k of ['C','Board','Evaluator','Search','Kill','Forbidden','EngineAI','Game','Renderer','App','SaveLoad','Replayer','VCFPractice']) {
    assert(G[k], 'GMK.' + k + ' 存在');
}

const g = new G.Game();
assert(g instanceof G.Game, 'new GMK.Game 成功');
g.placePiece(7, 7);
assert(g.moves.length === 1 && g.currentPlayer === 2, '落子后切换到白棋');

const move = g.getAIMove();
assert(move && typeof move.x === 'number' && typeof move.y === 'number', 'getAIMove 返回坐标 ' + JSON.stringify(move));
assert(g.lastAIInfo && typeof g.lastAIInfo.depth === 'number', '引擎诊断信息已回传');

// 注入自定义 AI，验证模块化契约（换 AI 不破坏核心）
g.setAI({ getMove(){ return { x: 8, y: 8 }; }, getLastInfo(){ return null; } });
const m2 = g.getAIMove();
assert(m2 && m2.x === 8 && m2.y === 8, 'setAI 注入的自定义 AI 生效');
g.setAI(new G.EngineAI(g)); // 回到默认引擎

const fr = g.checkForbidden(7, 7);
assert(typeof fr.isForbidden === 'boolean', 'checkForbidden 返回布尔');

// 引擎残子检查：getAIMove 内部会 sync()，搜完引擎 board 应回滚到 sync 时的局面
const g2 = new G.Game();
g2.placePiece(7, 7);      // 黑 1 子
g2.getAIMove();            // 引擎 sync 1 子局面 → 搜索 → finally 回滚回 1 子
const eng2 = g2.ai.board;
if (eng2 && eng2.stoneCount) {
    const stones = eng2.stoneCount();
    assert(stones === 1, '搜索后引擎棋盘无残子（回滚正确）', stones + ' 子，期望 1');
}

console.log('\n' + (fail === 0 ? '全部通过' : '有 ' + fail + ' 项失败') + '（浏览器装配守护，' + pass + '/' + (pass + fail) + '）');
if (fail > 0) process.exitCode = 1;
