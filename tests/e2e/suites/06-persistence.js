/** 06 存档与回放 */
'use strict';
const { clickCell, setPosition, stoneAt } = require('../harness');

async function run(t, { page }) {
    t.step('手动存档');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await clickCell(page, 8, 8);
    await page.evaluate(() => GMK.SaveLoad.save(window.game));
    const saved = await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('gmk_autosave_v2'));
        return d ? { moves: d.moves.length, board: d.boardState.length } : null;
    });
    t.ok(saved, '存档已写入 localStorage');
    t.eq(saved.moves, 2, '存档记录 2 手');
    t.eq(saved.board, 15, '存档棋盘 15 行');

    t.step('读档恢复');
    await page.evaluate(() => {
        window.game.reset();
        const d = JSON.parse(localStorage.getItem('gmk_autosave_v2'));
        window.game.loadFromData(d);
    });
    t.eq(await page.evaluate(() => window.game.moves.length), 2, '读档恢复 2 手');
    t.eq(await stoneAt(page, 7, 7), 1, '读档后天元有黑子');

    t.step('回放器');
    const rp = await page.evaluate(() => {
        const replayer = new GMK.Replayer(window.game.getMoves(), {});
        replayer.first();
        const b0 = replayer._boardAt(-1);
        replayer.step();
        const b1 = replayer._boardAt(0);
        return {
            empty: b0.flat().every(v => v === 0),
            hasStone: b1.flat().some(v => v !== 0),
            total: replayer.total
        };
    });
    t.ok(rp.empty, '回放第 0 帧空棋盘');
    t.ok(rp.hasStone, '回放第 1 帧有子');
    t.eq(rp.total, 2, '回放共 2 帧');

    t.step('清档');
    await page.evaluate(() => GMK.SaveLoad.clear());
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_autosave_v2')), null, '清档后为 null');
}

module.exports = { run };
