/** 03 AI 引擎：先落子后思考、PvE 执白应招、EvE 自动对战、引擎诊断信息 */
'use strict';
const { clickCell, setPosition, stoneAt } = require('../harness');

async function run(t, { page }) {
    // ① 先显示玩家落子，AI 再开始思考
    //    直接调 UI 的点击入口并在同一个同步任务里读状态：
    //    旧实现 placePiece → _render → getAIMove 全同步跑完，这里读到的会是 2 手；
    //    新实现只落玩家这一手，把搜索排到下一帧之后，读到的必须是 1 手 + thinking。
    t.step('先落子后思考');
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await page.evaluate(() => window.game.setAIDifficulty('HARD'));
    const mid = await page.evaluate(async (gx, gy) => {
        window.demo._onPlayerClick(gx, gy);
        const sync = {
            moves: window.game.moves.length,
            black: window.game.moves.filter(m => m.player === 1).length,
            thinking: window.demo.aiThinking
        };
        // ② 思考中再点别处：必须仍在同一个同步任务里做，
        //    否则往返一次 AI 已经算完、轮到黑棋，点下去当然会落子（假失败）。
        window.demo._onPlayerClick(3, 3);
        const blackAfterExtra = window.game.moves.filter(m => m.player === 1).length;

        // 只等一帧：本帧回调排在排期用的 rAF 之后、绘制之前，
        // 此时搜索定时器还没跑 —— 正是「玩家已上屏、AI 未动」的瞬间。
        await new Promise(res => requestAnimationFrame(res));
        const r2 = window.boardRenderer;
        const dpr = window.devicePixelRatio || 1;
        const px = Math.round((r2.padding + gx * r2.cellSize) * dpr);
        const py = Math.round((r2.padding + gy * r2.cellSize) * dpr);
        const d = r2.ctx.getImageData(px, py, 1, 1).data;
        return Object.assign(sync, {
            blackAfterExtra,
            movesAtFrame: window.game.moves.length,
            pixel: [d[0], d[1], d[2]]
        });
    }, 7, 7);
    t.eq(mid.moves, 1, '点完瞬间只有玩家这一手（AI 未同步落子）');
    t.eq(mid.black, 1, '玩家这一手已落盘');
    t.eq(mid.thinking, true, '点完瞬间已进入「AI 思考中」状态');
    t.eq(mid.blackAfterExtra, 1, '思考中连点不会插入第二手黑棋');
    t.eq(mid.movesAtFrame, 1, '下一帧里 AI 仍未落子（搜索排在绘制之后）');
    t.ok(mid.pixel[0] + mid.pixel[1] + mid.pixel[2] < 250,
        '该帧画布上已画出玩家的黑子（像素非木色）', 'rgb=' + mid.pixel.join(','));

    // ③ 让出主线程后 AI 应落第二手
    await page.waitForFunction('!window.demo.aiThinking', { timeout: 8000 });
    const after = await page.evaluate(() => ({
        moves: window.game.moves.length,
        white: window.game.moves.filter(m => m.player === 2).length,
        info: window.game.lastAIInfo ? { d: window.game.lastAIInfo.depth, n: window.game.lastAIInfo.nodes } : null
    }));
    t.eq(after.white, 1, 'AI 随后应招一手白棋');
    t.ok(after.info && after.info.d >= 1, '引擎诊断信息存在且有深度', JSON.stringify(after.info));

    // ④ 鼠标真实点击路径也要走通（canvas 命中 → 落子 → AI 应招）
    t.step('鼠标点击应招');
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    t.ok(await page.evaluate(() => window.game.moves.length) >= 2, '真实点击后 AI 也应招');

    // 挡五：摆白四连威胁，引擎应挡住
    t.step('挡五');
    await setPosition(page, [[3,7,2],[4,7,2],[5,7,2],[6,7,2]], { mode: 'PvE', currentPlayer: 1 });
    const block = await page.evaluate(() => {
        const m = window.game.getAIMove();   // 黑先手挡白
        return m;
    });
    t.ok(block && (block.x === 2 || block.x === 7), '黑方挡住了白四两端之一', JSON.stringify(block));

    // 成五：摆白活四，引擎应直接成五
    t.step('成五');
    await setPosition(page, [[3,3,1],[4,4,1],[5,5,1],[6,6,1]], { mode: 'PvE', currentPlayer: 1 });
    const winMove = await page.evaluate(() => window.game.getAIMove());
    const placed = await page.evaluate(m => {
        const r = window.game.placePiece(m.x, m.y);
        return { winner: window.game.winner, ok: r.success };
    }, winMove);
    t.eq(placed.winner, 1, '黑方沿斜向成五');

    // EvE 自动对战（不点棋盘，AI 自己打）
    t.step('EvE 自动对战');
    await setPosition(page, [], { mode: 'EvE', currentPlayer: 1 });
    await page.evaluate(() => { window.game.setBlackAIDifficulty('EASY'); window.game.setWhiteAIDifficulty('EASY'); window.demo.newGame(); });
    await new Promise(r => setTimeout(r, 1500));
    const eve = await page.evaluate(() => window.game.moves.length);
    t.ok(eve >= 2, 'EvE 自动落子 ≥ 2 手', 'moves=' + eve);
    await page.evaluate(() => { window.demo.eveAutoPlay = false; }); // 停止自动
}

module.exports = { run };
