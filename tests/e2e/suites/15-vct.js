'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** v2.7.0：VCT 题型（威胁=四或活三，判定与题库共用 TSS 求解器） */
module.exports = {
    name: '15 VCT 题型',
    async run(t, ctx) {
        const { page } = ctx;
        await page.evaluate(() => window.GMK.VCFPractice.clearProgress());

        // 下拉出现 VCT 分组，选项数与题库一致
        const ddl = await page.evaluate(() => {
            const sel = document.getElementById('vcf-puzzle-select');
            const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label);
            return { groups: groups, options: sel.options.length, total: window.GMK.VCFPractice.PUZZLES.length };
        });
        t.ok(ddl.groups.some((g) => g.indexOf('VCT') === 0), '下拉出现 VCT 分组', JSON.stringify(ddl.groups));
        t.eq(ddl.options, ddl.total, '下拉选项数与题库一致', ddl.options + ' vs ' + ddl.total);

        // 开始 vct-01
        const started = await page.evaluate(() => {
            const V = window.GMK.VCFPractice;
            const idx = V.indexOf('vct-01');
            const sel = document.getElementById('vcf-puzzle-select');
            sel.value = String(idx);
            window.demo._startVcf();
            return {
                mode: window.game.gameMode,
                type: window.demo.vcfPuzzle && window.demo.vcfPuzzle.type,
                hint: document.getElementById('hint-message').textContent
            };
        });
        t.eq(started.mode, 'VCF_PRACTICE', 'VCT 题开始进入练习模式');
        t.eq(started.type, 'vct', '题型标记为 vct');
        t.ok(/活三/.test(started.hint), '开局提示说明活三规则', started.hint);

        // 非威胁着法被拒（VCT 文案要提到活三）
        const bad = await page.evaluate(() => {
            window.demo._onPlayerClick(0, 0);
            return document.getElementById('vcf-status').textContent;
        });
        t.ok(/活三/.test(bad.msg || bad), 'VCT 非威胁着法提示含活三', String(bad));

        // 照提示通关（hint 走 TSS 求解器）
        const solved = await page.evaluate(() => {
            const s = window.demo.vcf;
            let guard = 0;
            while (guard++ < 10 && s.state === 'playing') {
                const h = s.hint();
                if (!h) break;
                window.demo._onPlayerClick(h.x, h.y);
            }
            return {
                state: s.state,
                steps: s.steps,
                msg: document.getElementById('vcf-status').textContent
            };
        });
        t.eq(solved.state, 'solved', 'VCT 题照提示通关');
        t.ok(solved.steps >= 2, 'VCT 至少两手威胁', String(solved.steps));
        t.ok(/已解/.test(solved.msg), '通关提示', solved.msg);

        // 成绩与连胜通道对 VCT 题同样生效
        const rec = await page.evaluate(() => !!window.GMK.VCFPractice.getRecord('vct-01'));
        t.eq(rec, true, 'VCT 通关写入成绩');
    }
};
