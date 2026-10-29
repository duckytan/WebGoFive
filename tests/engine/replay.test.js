/**
 * 回放器（Replayer）单元测试
 *
 * 锁定 onFrame 的 idx 语义：-1 表示「开局空盘」，0 表示「只画第 1 手」。
 * 早期实现在 _emit 里做了 Math.max(0, idx)，把 -1 抹成 0，
 * 结果 UI 的「回到开局」永远画着第一手，用户永远看不到空盘。
 */
'use strict';
const path = require('path');
const Replayer = require(path.join(__dirname, '..', '..', 'js', 'app', 'replay.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, extra) {
    if (cond) { pass++; return true; }
    fail++; failures.push(msg + (extra !== undefined ? '  [' + extra + ']' : ''));
    return false;
}
function eq(a, b, msg) { return ok(a === b, msg, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

/** 5 手棋：黑 H8 / 白 H9 / 黑 I8 / 白 I9 / 黑 J10 */
const MOVES = [
    { x: 7, y: 7, player: 1 }, { x: 7, y: 8, player: 2 }, { x: 8, y: 7, player: 1 },
    { x: 8, y: 8, player: 2 }, { x: 9, y: 9, player: 1 }
];

function make() {
    const frames = [];
    const r = new Replayer(MOVES, { onFrame: (b, i) => frames.push({ i, n: b.flat().filter(v => v).length }) });
    return { r, frames };
}

// ① 构造
{
    const { r } = make();
    eq(r.total, 5, 'total 等于着法数');
    eq(r.idx, -1, '初始 idx 为 -1（开局前）');
    eq(r.isEmpty, false, '有棋时 isEmpty=false');
    eq(new Replayer([], {}).isEmpty, true, '空着法 isEmpty=true');
}

// ② first / last / goto 的 idx 语义
{
    const { r, frames } = make();
    r.first();
    eq(r.idx, -1, 'first() 回到 -1');
    eq(frames[frames.length - 1].i, -1, 'onFrame 收到 -1（不是被抹成 0）');
    eq(frames[frames.length - 1].n, 0, '开局帧是空盘');

    r.last();
    eq(r.idx, 4, 'last() 到末手');
    eq(frames[frames.length - 1].i, 4, '末手帧 idx=4');
    eq(frames[frames.length - 1].n, 5, '末手帧共 5 子');

    r.goto(1);
    eq(r.idx, 1, 'goto(1) 定位到第 2 手');
    eq(frames[frames.length - 1].n, 2, '第 2 手帧共 2 子');

    r.goto(-5);
    eq(r.idx, -1, 'goto 负数夹到 -1');
    r.goto(99);
    eq(r.idx, 4, 'goto 超界夹到末手');
}

// ③ step / back
{
    const { r, frames } = make();
    eq(r.step(), 0, '开局 step() 走到 0');
    eq(frames[frames.length - 1].n, 1, '第 1 手帧共 1 子');
    eq(r.back(), -1, 'back() 从 0 回到 -1');
    eq(frames[frames.length - 1].n, 0, 'back 到开局后是空盘');
    r.last();
    eq(r.step(), 4, '末手再 step() 不动');
    eq(r.isEnd, true, '末手 isEnd=true');
}

// ④ 帧内容与坐标一一对应
{
    const { r } = make();
    let board = null;
    r._onFrame = (b) => { board = b; };
    r.goto(2);   // 前 3 手：黑 H8 / 白 H9 / 黑 I8
    eq(board.length, 15, '棋盘 15 行');
    eq(board[7][7], 1, 'H8 为黑');
    eq(board[8][7], 2, 'H9 为白');
    eq(board[7][8], 1, 'I8 为黑');
    eq(board[8][8], 0, 'I9 尚未落子');
}

// ⑤ 缺 player 字段时按奇偶推断
{
    const r = new Replayer([{ x: 0, y: 0 }, { x: 1, y: 1 }], {});
    const b = r._boardAt(1);
    eq(b[0][0], 1, '第 1 手缺 player 时推断为黑');
    eq(b[1][1], 2, '第 2 手缺 player 时推断为白');
}

// ⑥ play / pause 不泄漏定时器
{
    const r = new Replayer(MOVES, { speed: 10 });
    r.play();
    ok(r.playing === true, 'play() 后 playing=true');
    r.pause();
    ok(r.playing === false, 'pause() 后 playing=false');
    r.destroy();
    ok(r.playing === false, 'destroy() 后停止播放');
}

if (fail === 0) {
    console.log(`✓ 全部通过：${pass} 项`);
    process.exit(0);
} else {
    console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项`);
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
}
