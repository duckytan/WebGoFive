/**
 * 12 界面布局：侧栏分页 / 手数列表 / 复盘 / 计时 / 坐标开关
 *
 * 这一套保护的是「以人为本」的几条硬约定：
 *  - 侧栏一次只显示一页，任何一页都不能被挤出可视区（曾经 VCF 面板被挤到折叠线以下）
 *  - 手数列表与真实 moves 一一对应，点任意一手能复盘到那一步
 *  - 复盘期间棋盘归 Replayer，实时落子不得插进来
 */
'use strict';
const { setPosition } = require('../harness');

/**
 * 取某格「偏离格心 0.25 格」处的像素亮度和。
 * 格心是横竖网格线的交叉点，正对着取色会被深色线干扰，所以偏开一点。
 */
function probe(page, x, y) {
    return page.evaluate((gx, gy) => {
        const r = window.boardRenderer;
        const dpr = window.devicePixelRatio || 1;
        const px = Math.round((r.padding + (gx + 0.25) * r.cellSize) * dpr);
        const py = Math.round((r.padding + (gy + 0.25) * r.cellSize) * dpr);
        const d = r.ctx.getImageData(px, py, 1, 1).data;
        return d[0] + d[1] + d[2];
    }, x, y);
}

async function run(t, { page }) {
    // 前面几套会把主题持久化成 dark，这里固定回木质，像素断言才有确定基准
    await page.evaluate(() => window.demo.setTheme('wood'));
    await new Promise(r => setTimeout(r, 100));

    /* ---------------- ① 分页结构 ---------------- */
    t.step('侧栏分页');
    const tabs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ctrl-tab')).map(b => b.dataset.tab));
    t.eq(tabs.join(','), 'game,practice,analysis,settings', '侧栏有 对局/练习/分析/设置 四个分页');

    const panesOn = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('.ctrl-pane'))
            .filter(p => p.classList.contains('is-on')).map(p => p.dataset.pane));
    t.eq((await panesOn()).join(','), 'game', '初始只显示「对局」页');

    /* ---------------- ② 每一页都不越界 ---------------- */
    t.step('分页不越界');
    for (const name of ['game', 'practice', 'analysis', 'settings']) {
        await page.evaluate(n => window.demo.showTab(n), name);
        await new Promise(r => setTimeout(r, 60));
        const box = await page.evaluate(() => {
            const pane = document.querySelector('.ctrl-pane.is-on');
            const r = pane.getBoundingClientRect();
            return { h: r.height, bottom: r.bottom, vh: window.innerHeight, on: pane.dataset.pane };
        });
        t.eq(box.on, name, '切到「' + name + '」后只有这一页在显示');
        t.ok(box.h > 0, '「' + name + '」页有实际高度', 'h=' + Math.round(box.h));
        t.ok(box.bottom <= box.vh + 2, '「' + name + '」页底部不超出首屏（不用滚动才能看到）',
            'bottom=' + Math.round(box.bottom) + ' vh=' + box.vh);
    }

    // VCF 面板在练习页里，必须真的可见
    await page.evaluate(() => window.demo.showTab('practice'));
    await new Promise(r => setTimeout(r, 60));
    const vcfBox = await page.evaluate(() => {
        const r = document.getElementById('vcf-panel').getBoundingClientRect();
        return { h: r.height, w: r.width };
    });
    t.ok(vcfBox.h > 60 && vcfBox.w > 100, 'VCF 面板在练习页里有实际尺寸', JSON.stringify(vcfBox));

    /* ---------------- ③ 手数列表 ---------------- */
    t.step('手数列表');
    await page.evaluate(() => window.demo.showTab('game'));
    await setPosition(page, [[7, 7, 1], [7, 8, 2], [8, 7, 1], [8, 8, 2], [9, 9, 1]],
        { mode: 'PvP', currentPlayer: 2 });

    const mv = await page.evaluate(() => {
        const curEl = document.querySelector('#move-list li.is-cur');
        return {
            n: document.querySelectorAll('#move-list li.mv-item').length,
            count: document.getElementById('mv-count').textContent,
            pts: Array.from(document.querySelectorAll('#move-list .mv-pt')).map(e => e.textContent).join(' '),
            dots: Array.from(document.querySelectorAll('#move-list .mv-dot'))
                .map(e => e.className.replace('mv-dot ', '')).join(''),
            cur: curEl ? Number(curEl.dataset.i) : -1
        };
    });
    t.eq(mv.n, 5, '手数列表渲染 5 条');
    t.eq(mv.count, '5 手', '#mv-count 显示 5 手');
    t.eq(mv.pts, 'H8 H9 I8 I9 J10', '手数列表坐标与落子一致');
    t.eq(mv.dots, 'bwbwb', '黑白子标记交替正确');
    t.eq(mv.cur, 4, '默认高亮最后一手');

    /* ---------------- ④ 点手数 → 复盘到那一步 ---------------- */
    t.step('点手数复盘');
    const emptySum = await probe(page, 3, 3);   // 参考底色（空点）
    t.ok(emptySum > 400, '空点取到的是浅色棋盘底色', 'sum=' + emptySum);

    await page.evaluate(() => document.querySelectorAll('#move-list li.mv-item')[1].click());
    await new Promise(r => setTimeout(r, 120));

    const rev = await page.evaluate(() => {
        const curEl = document.querySelector('#move-list li.is-cur');
        return {
            reviewing: window.demo.reviewing,
            pos: document.getElementById('rp-pos').textContent,
            panelShown: document.getElementById('replay-player').style.display !== 'none',
            cur: curEl ? Number(curEl.dataset.i) : -1,
            liveMoves: window.game.moves.length
        };
    });
    t.eq(rev.reviewing, true, '点手数后进入复盘');
    t.eq(rev.pos, '2 / 5', '#rp-pos 显示 2 / 5');
    t.ok(rev.panelShown, '复盘控制条显示');
    t.eq(rev.cur, 1, '手数列表高亮跟随复盘位置');
    t.eq(rev.liveMoves, 5, '复盘不改动真实对局 moves');

    // 画布必须真的只画了 2 子：第 1 手（黑）在，第 3 手（黑）不在
    const px1 = await probe(page, 7, 7);
    const px3 = await probe(page, 8, 7);
    t.ok(px1 < 250, '复盘到第 2 手：H8 的黑子仍在画布上', 'sum=' + px1);
    t.ok(px3 > 400, '复盘到第 2 手：第 3 手 I8 尚未画出', 'sum=' + px3);

    /* ---------------- ⑤ 复盘期间禁止落子 ---------------- */
    t.step('复盘期间禁止落子');
    await page.evaluate(() => window.demo._onPlayerClick(0, 0));
    const guard = await page.evaluate(() => ({
        moves: window.game.moves.length,
        msg: document.getElementById('hint-message').textContent
    }));
    t.eq(guard.moves, 5, '复盘期间点棋盘不会落子');
    t.ok(/复盘/.test(guard.msg), '复盘期间点棋盘给出提示', guard.msg);

    /* ---------------- ⑥ 步进 / 退出 ---------------- */
    t.step('复盘步进与退出');
    await page.evaluate(() => document.getElementById('rp-fwd').click());
    t.eq(await page.evaluate(() => document.getElementById('rp-pos').textContent), '3 / 5', '▶| 前进一步');
    await page.evaluate(() => document.getElementById('rp-first').click());
    t.eq(await page.evaluate(() => document.getElementById('rp-pos').textContent), '0 / 5', '⏮ 回到开局');
    t.ok(await probe(page, 7, 7) > 400, '回到开局时画布是空盘（第 1 手也不画）');
    await page.evaluate(() => document.getElementById('rp-last').click());
    t.eq(await page.evaluate(() => document.getElementById('rp-pos').textContent), '5 / 5', '⏭ 跳到末手');

    await page.evaluate(() => document.getElementById('rp-exit').click());
    await new Promise(r => setTimeout(r, 100));
    const exit = await page.evaluate(() => {
        const curEl = document.querySelector('#move-list li.is-cur');
        return {
            reviewing: window.demo.reviewing,
            panelShown: document.getElementById('replay-player').style.display !== 'none',
            cur: curEl ? Number(curEl.dataset.i) : -1
        };
    });
    t.eq(exit.reviewing, false, '退出复盘');
    t.eq(exit.panelShown, false, '退出后控制条隐藏');
    t.eq(exit.cur, 4, '退出后高亮回到最后一手');
    t.ok(await probe(page, 8, 7) < 250, '退出复盘后画布恢复实时局面（I8 的黑子回来了）');

    // 空局面点复盘：不进入复盘
    await setPosition(page, [], { mode: 'PvP', currentPlayer: 1 });
    await page.evaluate(() => window.demo._startReview());
    t.eq(await page.evaluate(() => window.demo.reviewing), false, '没有落子时点复盘不会进入复盘');
    t.eq(await page.evaluate(() => document.querySelectorAll('#move-list li.mv-item').length), 0,
        '空局面手数列表无条目');

    /* ---------------- ⑦ 计时 ---------------- */
    t.step('对局计时');
    const t1 = await page.evaluate(() => document.getElementById('elapsed').textContent);
    t.ok(/^\d{2}:\d{2}$/.test(t1), '#elapsed 为 mm:ss 格式', t1);
    await page.evaluate(() => {
        window.game.startTime = Date.now() - 65000;
        window.demo._paintTimer();
    });
    t.eq(await page.evaluate(() => document.getElementById('elapsed').textContent), '01:05',
        '计时按真实用时换算');

    /* ---------------- ⑧ 坐标开关 ---------------- */
    t.step('坐标开关');
    await page.evaluate(() => window.demo.showTab('settings'));
    const coordOn = await page.evaluate(() => ({
        checked: document.getElementById('toggle-coords').checked,
        renderer: window.boardRenderer.showCoords
    }));
    t.eq(coordOn.checked, coordOn.renderer, '坐标勾选状态与渲染器一致（初始）');
    await page.evaluate(() => document.getElementById('toggle-coords').click());
    const coordOff = await page.evaluate(() => ({
        checked: document.getElementById('toggle-coords').checked,
        renderer: window.boardRenderer.showCoords,
        saved: localStorage.getItem('gmk_coords')
    }));
    t.eq(coordOff.renderer, false, '取消勾选后渲染器关闭坐标');
    t.eq(coordOff.checked, false, '勾选框与渲染器同步（旧实现这里是反的）');
    t.eq(coordOff.saved, '0', '坐标偏好写入 localStorage');
    await page.evaluate(() => document.getElementById('toggle-coords').click());
    t.eq(await page.evaluate(() => window.boardRenderer.showCoords), true, '再次点击恢复坐标');

    /* ---------------- ⑨ 分析页在 EvE 下自动让位 ---------------- */
    t.step('分析页空态');
    await page.evaluate(() => { window.demo.showTab('analysis'); window.demo.setMode('EvE'); });
    await new Promise(r => setTimeout(r, 200));
    const eve = await page.evaluate(() => ({
        pane: document.querySelector('.ctrl-pane.is-on').dataset.pane,
        panelHidden: document.getElementById('ai-analysis-panel').style.display === 'none'
    }));
    t.eq(eve.pane, 'game', 'EvE 下停在分析页会自动跳到「对局」页');
    t.ok(eve.panelHidden, 'EvE 下 AI 分析面板隐藏');
    await page.evaluate(() => { window.demo.eveAutoPlay = false; window.demo.setMode('PvP'); });
    await new Promise(r => setTimeout(r, 200));
    t.eq(await page.evaluate(() => window.demo.tab), 'game', '切回 PvP 后分页状态正常');
}

module.exports = { run };
