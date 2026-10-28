/** 07 移动端适配：390px 视口不溢出 */
'use strict';
const { getBaseUrl } = require('../harness');

async function run(t, { page }) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(getBaseUrl() + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.demo && window.game', { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));

    const m = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        overflow: getComputedStyle(document.documentElement).overflowX
    }));
    t.ok(m.scrollW <= m.innerW + 1, '390px 无横向溢出', 'scrollW=' + m.scrollW + ' innerW=' + m.innerW);
    t.eq(m.overflow, 'clip', 'html overflow-x: clip');

    // 棋盘在移动视口里仍可见
    const visible = await page.evaluate(() => {
        const c = document.getElementById('board-canvas');
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.width <= window.innerWidth + 1;
    });
    t.ok(visible, '棋盘在 390px 视口内可见');
}

module.exports = { run };
