/** 04 游戏模式：PvP / PvE / EvE 切换 + 禁用玩家操作 */
'use strict';
const { clickCell, setPosition, stoneAt } = require('../harness');

async function run(t, { page }) {
    // 模式按钮可切换
    t.step('PvP');
    await page.evaluate(() => document.getElementById('mode-PvP').click());
    t.eq(await page.evaluate(() => window.game.gameMode), 'PvP', '切到 PvP');

    t.step('PvE');
    await page.evaluate(() => document.getElementById('mode-PvE').click());
    t.eq(await page.evaluate(() => window.game.gameMode), 'PvE', '切到 PvE');

    t.step('EvE');
    await page.evaluate(() => document.getElementById('mode-EvE').click());
    t.eq(await page.evaluate(() => window.game.gameMode), 'EvE', '切到 EvE');

    // EvE 下玩家点棋盘不应落子
    t.step('EvE 玩家禁操作');
    await setPosition(page, [], { mode: 'EvE', currentPlayer: 1 });
    await page.evaluate(() => { window.demo.eveAutoPlay = false; });
    await clickCell(page, 7, 7);
    t.eq(await stoneAt(page, 7, 7), 0, 'EvE 玩家点击不落子');

    // 难度切换
    t.step('难度');
    await page.evaluate(() => document.getElementById('diff-HELL').click());
    t.eq(await page.evaluate(() => window.game.aiDifficulty), 'HELL', '难度切到 HELL');
}

module.exports = { run };
