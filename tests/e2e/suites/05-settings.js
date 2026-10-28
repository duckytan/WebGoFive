/** 05 设置系统：主题/模式/难度/坐标 持久化 */
'use strict';
const { setPosition } = require('../harness');

async function run(t, { page }) {
    t.step('主题');
    await page.evaluate(() => document.getElementById('theme-dark').click());
    t.eq(await page.evaluate(() => document.body.getAttribute('data-theme')), 'dark', 'body data-theme=dark');
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_theme')), 'dark', '主题已持久化');
    t.ok(await page.evaluate(() => document.getElementById('theme-dark').classList.contains('active')), 'dark 按钮高亮');

    t.step('模式');
    await page.evaluate(() => document.getElementById('mode-PvP').click());
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_mode')), 'PvP', '模式已持久化');

    t.step('难度');
    await page.evaluate(() => document.getElementById('diff-HARD').click());
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_diff')), 'HARD', '难度已持久化');

    t.step('坐标开关');
    await page.evaluate(() => { window.boardRenderer.setShowCoords(false); });
    t.ok(await page.evaluate(() => !window.boardRenderer.showCoords), '坐标已关');
    await page.evaluate(() => { window.boardRenderer.setShowCoords(true); });
    t.ok(await page.evaluate(() => window.boardRenderer.showCoords), '坐标已开');

    t.step('重载后设置恢复');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.demo && window.game', { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_theme')), 'dark', '重载后主题仍在 dark');
    t.eq(await page.evaluate(() => window.game.gameMode), 'PvP', '重载后模式恢复 PvP');
}

module.exports = { run };
