/** 10 P2 增强：HELL 高级棋力选项（可见性/透传/持久化/守卫）+ 开局定式推荐（前 4 手） */
'use strict';
const { clickCell, setPosition } = require('../harness');

async function run(t, { page }) {
    // ① 高级面板可见性：普通隐藏，地狱显示
    t.step('高级面板可见性');
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await page.evaluate(() => window.demo.setDifficulty('NORMAL'));
    const hiddenNormal = await page.evaluate(() =>
        document.getElementById('strength-advanced').style.display === 'none');
    t.ok(hiddenNormal, '普通难度下 #strength-advanced 隐藏');
    await page.evaluate(() => window.demo.setDifficulty('HELL'));
    const visibleHell = await page.evaluate(() =>
        document.getElementById('strength-advanced').style.display !== 'none');
    t.ok(visibleHell, '地狱难度下 #strength-advanced 显示');

    // ② 参数输入 → sanitize 后注入包装 AI + localStorage 持久化
    t.step('参数透传与持久化');
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change'));
        };
        set('adv-time', '800'); set('adv-depth', '6'); set('adv-cand', '12');
    });
    const ov = await page.evaluate(() => window.demo.strengthOverride);
    t.ok(ov && ov.timeMs === 800 && ov.depth === 6 && ov.candidates === 12,
        '输入清洗后注入 override', JSON.stringify(ov));
    const persisted = await page.evaluate(() => localStorage.getItem('gmk_strength_hell'));
    t.ok(persisted && JSON.parse(persisted).timeMs === 800, 'override 已持久化', persisted);
    const wrapped = await page.evaluate(() =>
        !!window.game.ai && typeof window.game.ai.setOverride === 'function');
    t.ok(wrapped, 'game.ai 已是可调参包装层');

    // ③ 越界清洗：时间 5ms → 夹到下限 100ms
    t.step('越界清洗');
    await page.evaluate(() => {
        const el = document.getElementById('adv-time');
        el.value = '5';
        el.dispatchEvent(new Event('change'));
    });
    t.eq(await page.evaluate(() => window.demo.strengthOverride.timeMs), 100, '越界时间被夹到下限 100ms');

    // ④ 恢复默认：override 清空 + 存档清除
    t.step('恢复默认');
    await page.evaluate(() => document.getElementById('btn-strength-reset').click());
    t.eq(await page.evaluate(() => window.demo.strengthOverride), null, '恢复默认后 override 为空');
    t.eq(await page.evaluate(() => localStorage.getItem('gmk_strength_hell')), null, '恢复默认后存档清除');

    // ⑤ HELL + 自定义参数真实落子：诊断 difficulty=HELL 且深度不超配置
    t.step('HELL 自定义参数落子');
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change'));
        };
        set('adv-time', '400'); set('adv-depth', '4'); set('adv-cand', '8');
    });
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    await clickCell(page, 7, 7); // 玩家黑 + AI 白（HELL，400ms 上限）
    const info = await page.evaluate(() => window.game.lastAIInfo);
    t.ok(info && info.difficulty === 'HELL', 'HELL 落子诊断 difficulty 正确', JSON.stringify(info));
    t.ok(info && info.depth >= 1 && info.depth <= 4, '实际深度不超自定义上限', info && ('depth=' + info.depth));

    // ⑥ 开局推荐：新对局面板立即给出天元，source=开局
    t.step('开局推荐');
    await page.evaluate(() => window.demo.newGame());
    await new Promise(r => setTimeout(r, 200));
    const rec = await page.evaluate(() => ({
        best: document.getElementById('ai-best-move').textContent,
        src: document.getElementById('ai-source').textContent
    }));
    t.ok(/^H8 \(7,7\)$/.test(rec.best.trim()), '开局推荐为天元 H8(7,7)', rec.best);
    t.eq(rec.src, '开局', '开局推荐 source 标签');

    // ⑦ 出窗：第 4 手后不再显示开局推荐
    t.step('开局窗口出窗');
    await setPosition(page, [[7,7,1],[7,8,2],[8,7,1],[8,8,2]], { mode: 'PvE', currentPlayer: 1 });
    await clickCell(page, 9, 9); // 玩家黑第 5 手 + AI 白应招
    const srcAfter = await page.evaluate(() => document.getElementById('ai-source').textContent);
    t.ok(srcAfter !== '开局', '第 5 手起不再显示开局推荐', srcAfter);

    // ⑧ PvP 同样有开局推荐
    t.step('PvP 开局推荐');
    await page.evaluate(() => window.demo.setMode('PvP'));
    await new Promise(r => setTimeout(r, 300));
    const pvpBest = await page.evaluate(() => document.getElementById('ai-best-move').textContent);
    t.ok(/\(7,7\)/.test(pvpBest), 'PvP 新局同样显示开局推荐', pvpBest);
}

module.exports = { run };
