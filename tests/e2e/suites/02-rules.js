/** 02 规则与胜负：横五、斜五、三三禁手、悔棋、新游戏 */
'use strict';
const { clickCell, setPosition, stoneAt } = require('../harness');

async function run(t, { page }) {
    // 横向五连
    t.step('横向五连');
    await setPosition(page, [[3,7,1],[4,7,1],[5,7,1],[6,7,1]], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await page.waitForFunction(() => document.getElementById('game-result-modal').classList.contains('active'), { timeout: 4000 }).catch(() => {});
    t.eq(await page.evaluate(() => window.game.winner), 1, '黑棋横五获胜');
    await page.evaluate(() => document.getElementById('close-result-btn').click());

    // 斜向五连
    t.step('斜向五连');
    await setPosition(page, [[3,3,1],[4,4,1],[5,5,1],[6,6,1]], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await page.waitForFunction(() => document.getElementById('game-result-modal').classList.contains('active'), { timeout: 4000 }).catch(() => {});
    t.eq(await page.evaluate(() => window.game.winner), 1, '黑棋斜五获胜');
    await page.evaluate(() => document.getElementById('close-result-btn').click());

    // 三三禁手（黑棋）
    t.step('三三禁手');
    await setPosition(page, [[2,7,1],[3,7,1],[4,8,1],[4,9,1]], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 4, 7);  // 这个点会形成双活三
    const cur = await page.evaluate(() => window.game.currentPlayer);
    t.ok(cur === 1, '禁手落子被拒绝，仍轮到黑棋', 'current=' + cur);
    t.eq(await stoneAt(page, 4, 7), 0, '禁手位置未被占');

    // 悔棋
    t.step('悔棋');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await clickCell(page, 8, 8);
    const cnt = await page.evaluate(() => window.game.moves.length);
    t.eq(cnt, 2, '落 2 手');
    await page.evaluate(() => window.demo.undo());
    t.eq(await page.evaluate(() => window.game.moves.length), 1, '悔 1 步');

    // 新游戏
    t.step('新游戏');
    await page.evaluate(() => window.demo.newGame());
    t.eq(await page.evaluate(() => window.game.moves.length), 0, '新游戏清空棋盘');
}

module.exports = { run };
