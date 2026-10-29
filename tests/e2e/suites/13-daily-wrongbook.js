'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** v2.5.0：深度评估 Worker 化 / VCF 每日一题 / 错题本 */
module.exports = {
    name: '13 每日一题与错题本',
    async run(t, ctx) {
        const { page } = ctx;

        // ---- 深度评估：走 Worker（真实 Edge + http 环境），主线程不冻结 ----
        await page.evaluate(() => window.GMK.VCFPractice.clearProgress());
        await page.evaluate(() => { document.getElementById('btn-deep-eval').click(); });
        const deep = await page.waitForFunction(() => window.demo._lastDeepEval, { timeout: 15000 })
            .then(() => true).catch(() => false);
        t.ok(deep, '深度评估在 15s 内出结果');
        if (deep) {
            const d = await page.evaluate(() => ({
                via: window.demo._lastDeepEval.via,
                workerAvail: window.GMK.DeepEval.workerAvailable(),
                best: document.getElementById('ai-best-move').textContent
            }));
            t.eq(d.via, 'worker', '深度评估走 Worker 路径', 'via=' + d.via);
            t.eq(d.workerAvail, true, 'Edge/http 下 Worker 可用');
            t.ok(d.best && d.best !== '—', '#ai-best-move 已填入最佳点', d.best);
        }

        // ---- 每日一题：选题 = 日期哈希，通关累积连胜 ----
        await page.evaluate(() => { document.getElementById('btn-vcf-daily').click(); });
        await sleep(150);
        const dailyStart = await page.evaluate(() => {
            const V = window.GMK.VCFPractice;
            return {
                mode: window.game.gameMode,
                startedId: window.demo.vcfPuzzle && window.demo.vcfPuzzle.id,
                expectedId: V.daily().puzzle.id,
                info: document.getElementById('vcf-daily-info').textContent
            };
        });
        t.eq(dailyStart.mode, 'VCF_PRACTICE', '每日一题切到练习模式');
        t.eq(dailyStart.startedId, dailyStart.expectedId,
            '开始的题与日期哈希选题一致', dailyStart.startedId + ' vs ' + dailyStart.expectedId);
        t.ok(/连胜/.test(dailyStart.info), '面板显示连胜信息', dailyStart.info);

        const dailySolved = await page.evaluate(() => {
            const s = window.demo.vcf;
            let guard = 0;
            while (guard++ < 25 && s.state === 'playing') {
                const h = s.hint();
                if (!h) break;
                window.demo._onPlayerClick(h.x, h.y);
            }
            return {
                state: s.state,
                daily: window.GMK.VCFPractice.daily(),
                info: document.getElementById('vcf-daily-info').textContent
            };
        });
        t.eq(dailySolved.state, 'solved', '每日一题照提示可通关');
        t.eq(dailySolved.daily.solved, true, '通关后当日标记已解');
        t.ok(dailySolved.daily.streak >= 1, '连胜计数 ≥ 1', String(dailySolved.daily.streak));
        t.ok(/已解/.test(dailySolved.info), '#vcf-daily-info 显示已解', dailySolved.info);

        // ---- 错题本：非冲四 / 看答案 都要记账，重练直达 ----
        await page.evaluate(() => {
            const sel = document.getElementById('vcf-puzzle-select');
            sel.value = '0';
            window.demo._startVcf();
        });
        await sleep(150);
        await page.evaluate(() => window.demo._onPlayerClick(0, 0));   // 非冲四
        await page.evaluate(() => { document.getElementById('btn-vcf-solution').click(); }); // 看答案
        await sleep(150);

        const wb = await page.evaluate(() => ({
            count: window.GMK.VCFPractice.wrongbookCount(),
            reasons: window.GMK.VCFPractice.wrongbookList().map((i) => i.reason)
        }));
        t.eq(wb.count, 2, '非冲四 + 看答案各记一条', JSON.stringify(wb));
        t.ok(wb.reasons.includes('not-four'), '记录「不是冲四」');
        t.ok(wb.reasons.includes('gave-up'), '记录「看了答案」');

        await page.evaluate(() => { document.getElementById('btn-vcf-wrongbook').click(); });
        const listShown = await page.evaluate(() => {
            const box = document.getElementById('vcf-wrongbook');
            return { visible: box.style.display !== 'none', items: box.querySelectorAll('.vcf-wb-item').length };
        });
        t.eq(listShown.visible, true, '错题本可展开');
        t.ok(listShown.items >= 2, '列表渲染出条目', listShown.items + ' 条');

        // 点「重练」：回到那条错题，列表收起
        await page.evaluate(() => {
            document.querySelector('#vcf-wrongbook .vcf-wb-item button').click();
        });
        await sleep(200);
        const restart = await page.evaluate(() => ({
            puzzle: window.demo.vcfPuzzle && window.demo.vcfPuzzle.id,
            mode: window.game.gameMode,
            boxHidden: document.getElementById('vcf-wrongbook').style.display === 'none'
        }));
        t.eq(restart.puzzle, 'vcf-01', '重练直达错题对应的题目', restart.puzzle);
        t.eq(restart.mode, 'VCF_PRACTICE', '重练处于练习模式');
        t.eq(restart.boxHidden, true, '重练后错题本收起');
    }
};
