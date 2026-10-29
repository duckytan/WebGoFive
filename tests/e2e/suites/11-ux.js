/** 11 操作逻辑：键盘落子、落子确认、两步悔棋、认输、棋谱导入导出、战绩 */
'use strict';
const { clickCell, setPosition, stoneAt } = require('../harness');

async function run(t, { page }) {
    // ① 键盘：方向键移动光标，Enter 落子
    t.step('键盘操作');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await page.evaluate(() => { window.demo.cursor = { x: 7, y: 7 }; window.boardRenderer.setCursor({ x: 7, y: 7 }); });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const cur = await page.evaluate(() => window.demo.cursor);
    t.eq(cur.x, 8, '→ 键光标右移');
    t.eq(cur.y, 8, '↓ 键光标下移');
    t.ok(await page.evaluate(() => !!window.boardRenderer.cursor), '光标已画在渲染器上');

    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 120));
    t.eq(await stoneAt(page, 8, 8), 1, 'Enter 在光标处落黑子');

    // 输入框里不抢按键
    await page.evaluate(() => document.getElementById('record-box').focus());
    await page.keyboard.press('ArrowLeft');
    t.eq(await page.evaluate(() => window.demo.cursor.x), 8, '在输入框内方向键不移动光标');

    // ② 落子确认：第一下只预览，第二下才落子
    t.step('落子确认');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await page.evaluate(() => {
        const el = document.getElementById('toggle-confirm');
        el.checked = true;
        el.dispatchEvent(new Event('change'));
    });
    await clickCell(page, 6, 6);
    t.eq(await stoneAt(page, 6, 6), 0, '开启确认后第一次点击不落子');
    t.ok(await page.evaluate(() => !!window.boardRenderer.pending), '第一次点击只画预览子');
    await clickCell(page, 6, 6);
    t.eq(await stoneAt(page, 6, 6), 1, '再点同一格才真正落子');
    t.ok(await page.evaluate(() => !window.boardRenderer.pending), '落子后预览子清除');

    await page.evaluate(() => {
        const el = document.getElementById('toggle-confirm');
        el.checked = false;
        el.dispatchEvent(new Event('change'));
    });
    await clickCell(page, 2, 2);
    t.eq(await stoneAt(page, 2, 2), 2, '关闭确认后单击即落子（轮到白）');

    // ③ 两步悔棋：人机对战里要连 AI 的应手一起撤
    t.step('两步悔棋');
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await page.evaluate(() => window.game.setAIDifficulty('BEGINNER'));
    await clickCell(page, 7, 7);
    const beforeUndo = await page.evaluate(() => window.game.moves.length);
    t.ok(beforeUndo >= 2, '人机对战已形成「我方 + AI」两手', 'moves=' + beforeUndo);
    await page.evaluate(() => document.getElementById('undo-btn').click());
    await new Promise(r => setTimeout(r, 100));
    t.eq(await page.evaluate(() => window.game.moves.length), beforeUndo - 2, '悔棋一次撤掉两手（含 AI 应手）');

    // ④ 认输
    t.step('认输');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await page.evaluate(() => document.getElementById('resign-btn').click());
    const resigned = await page.evaluate(() => ({
        status: window.game.gameStatus,
        winner: window.game.winner,
        modal: document.getElementById('game-result-modal').classList.contains('active'),
        title: document.getElementById('result-title').textContent
    }));
    t.eq(resigned.status, 'finished', '认输后对局结束');
    t.eq(resigned.winner, 2, '黑方认输 → 白方获胜');
    t.ok(resigned.modal, '认输后弹出结算');
    t.ok(/白方获胜/.test(resigned.title), '结算标题正确', resigned.title);

    // ⑤ 导出 / 导入棋谱
    t.step('棋谱导入导出');
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await clickCell(page, 8, 8);
    await page.evaluate(() => document.getElementById('btn-export').click());
    const rec = await page.evaluate(() => document.getElementById('record-box').value.trim());
    t.eq(rec, 'H8 I9', '导出棋谱为坐标序列');

    await page.evaluate(() => {
        const box = document.getElementById('record-box');
        box.value = 'H8 I9 G9 G8 F8';
        document.getElementById('btn-import').click();
    });
    await new Promise(r => setTimeout(r, 150));
    const imported = await page.evaluate(() => ({
        moves: window.game.moves.length,
        mode: window.game.gameMode,
        first: window.game.moves[0] ? [window.game.moves[0].x, window.game.moves[0].y] : null
    }));
    t.eq(imported.moves, 5, '导入 5 手全部落子');
    t.eq(imported.mode, 'PvP', '导入后切到双人模式');
    t.eq(imported.first && imported.first.join(','), '7,7', '导入的首手是 H8');

    // 非法棋谱要被拒
    await page.evaluate(() => {
        const box = document.getElementById('record-box');
        box.value = 'H8 ZZ';
        document.getElementById('btn-import').click();
    });
    t.ok(/格式不对/.test(await page.evaluate(() => document.getElementById('hint-message').textContent)),
        '非法棋谱被拒并提示');

    // ⑥ 战绩：人机认输后计入负场
    t.step('战绩统计');
    await page.evaluate(() => localStorage.removeItem('gmk_stats'));
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await clickCell(page, 7, 7);
    await page.evaluate(() => document.getElementById('resign-btn').click());
    await new Promise(r => setTimeout(r, 120));
    const stat = await page.evaluate(() => document.getElementById('stat-line').textContent);
    t.ok(/负/.test(stat), '人机认输计入负场', stat);
    t.ok(/胜率/.test(stat), '战绩显示胜率', stat);

    // ⑦ 音效开关可切换并持久化
    t.step('音效开关');
    await page.evaluate(() => {
        const el = document.getElementById('toggle-sound');
        el.checked = false;
        el.dispatchEvent(new Event('change'));
    });
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_sound')), '0', '关闭音效写入偏好');
    t.eq(await page.evaluate(() => window.demo.soundOn), false, '音效开关生效');
}

module.exports = { run };
