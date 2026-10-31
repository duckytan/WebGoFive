'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** v2.6.0：自定义题库（摆题→校验→入库→删除）/ 限时挑战（倒计时→超时判负） */
module.exports = {
    name: '14 自定义题与限时',
    async run(t, ctx) {
        const { page } = ctx;
        await page.evaluate(() => window.GMK.VCFPractice.clearProgress());

        // ---- 限时挑战：改短时限 → 倒计时 → 超时判负 → 拒收落子 ----
        await page.evaluate(() => {
            window.GMK.VCFPractice.TIME_LIMIT[1] = 3;   // 压到 3s，E2E 不真等 45s
            document.getElementById('chk-vcf-timed').checked = true;
            const sel = document.getElementById('vcf-puzzle-select');
            sel.value = '0';
            window.demo._startVcf();
        });
        await sleep(150);
        const timerOn = await page.evaluate(() => ({
            visible: document.getElementById('vcf-timer').style.display !== 'none',
            text: document.getElementById('vcf-timer').textContent
        }));
        t.eq(timerOn.visible, true, '限时模式下倒计时可见');
        t.ok(/⏱/.test(timerOn.text), '倒计时带钟表标记', timerOn.text);

        await sleep(3400);
        const timedOut = await page.evaluate(() => ({
            hidden: document.getElementById('vcf-timer').style.display === 'none',
            msg: document.getElementById('vcf-status').textContent,
            stepsBefore: window.demo.vcf.steps
        }));
        t.eq(timedOut.hidden, true, '超时后倒计时收起');
        t.ok(/时间到/.test(timedOut.msg), '#vcf-status 提示时间到', timedOut.msg);

        // 超时后落子被拒收：_vcfPlay 第一道闸是超时封锁，提示「时间到」
        await page.evaluate(() => window.demo._onPlayerClick(0, 0));
        const refused = await page.evaluate(() => ({
            steps: window.demo.vcf.steps,
            hint: document.getElementById('hint-message').textContent
        }));
        t.eq(refused.steps, timedOut.stepsBefore, '超时后落子不计步');
        t.ok(/时间到/.test(refused.hint), '超时后提示时间到', refused.hint);

        // 超时进入错题本（reason=timeout）
        const wbTimeout = await page.evaluate(() =>
            window.GMK.VCFPractice.wrongbookList().some((w) => w.reason === 'timeout'));
        t.eq(wbTimeout, true, '超时记入错题本');

        // 关掉限时重来：不再有倒计时，按提示落子正常计步
        await page.evaluate(() => {
            document.getElementById('chk-vcf-timed').checked = false;
            document.getElementById('btn-vcf-restart').click();
        });
        await sleep(150);
        const timerOff = await page.evaluate(() => ({
            hidden: document.getElementById('vcf-timer').style.display === 'none',
            hintPoint: window.demo.vcf.hint()
        }));
        t.eq(timerOff.hidden, true, '关闭限时后无倒计时');
        const played = await page.evaluate((h) => {
            window.demo._onPlayerClick(h.x, h.y);
            return window.demo.vcf.steps;
        }, timerOff.hintPoint);
        t.eq(played, 1, '关闭限时后可正常落子（冲四计步）');

        // ---- 摆题：空盘保存被拒 → 合法盘面入库 → 删此题 ----
        await page.evaluate(() => { document.getElementById('btn-vcf-edit').click(); });
        await sleep(120);
        const editOn = await page.evaluate(() => ({
            panel: document.getElementById('vcf-edit-actions').style.display !== 'none',
            stone: window.game.board[0][0]
        }));
        t.eq(editOn.panel, true, '摆题模式展开操作行');

        await page.evaluate(() => window.demo._onPlayerClick(0, 0));
        const placed = await page.evaluate(() => window.game.board[0][0]);
        t.eq(placed, 1, '摆题点击落黑子');

        // 再点变白、再点清除（黑→白→清除循环）
        const cycle = await page.evaluate(() => {
            window.demo._onPlayerClick(0, 0);
            const w = window.game.board[0][0];
            window.demo._onPlayerClick(0, 0);
            return { white: w, cleared: window.game.board[0][0] };
        });
        t.eq(cycle.white, 2, '再点变白子');
        t.eq(cycle.cleared, 0, '再点清除');

        // 只摆一颗黑子 → 校验拒绝
        await page.evaluate(() => {
            window.demo._onPlayerClick(7, 7);
            document.getElementById('btn-vcf-save').click();
        });
        const rejected = await page.evaluate(() => document.getElementById('vcf-status').textContent);
        t.ok(/保存失败/.test(rejected), '非法盘面保存被拒', rejected);

        // 载入内置两手题的盘面 → 保存通过 → 下拉出现自定义组并自动选中
        // 题库总数动态取值（VCT 加入后是 15，别再硬编码 9）
        const baseCount = await page.evaluate(() => window.GMK.VCFPractice.PUZZLES.length);
        const saved = await page.evaluate(() => {
            const V = window.GMK.VCFPractice;
            window.game.loadCustomState({ board: V.PUZZLES[1].board.map((r) => r.slice()), currentPlayer: 1, gameStatus: 'playing', moves: [] });
            document.getElementById('btn-vcf-save').click();
            const sel = document.getElementById('vcf-puzzle-select');
            const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label);
            const p = window.demo.vcfPuzzle;
            return {
                ok: !!(p && p.custom),
                mode: window.game.gameMode,
                groups: groups,
                selectedIsCustom: !!(p && /^custom-/.test(p.id)),
                delVisible: document.getElementById('btn-vcf-del').style.display !== 'none',
                count: V.PUZZLES.length
            };
        });
        t.eq(saved.ok, true, '合法盘面保存成功并开始练习');
        t.eq(saved.mode, 'VCF_PRACTICE', '保存后进入练习模式');
        t.ok(saved.groups.includes('自定义'), '下拉出现「自定义」分组', JSON.stringify(saved.groups));
        t.eq(saved.selectedIsCustom, true, '新题被自动选中');
        t.eq(saved.delVisible, true, '自定义题显示「删此题」');

        // 下拉选项数与题库同长（09 套件的不变量在动态题库下依然成立）
        const consistent = await page.evaluate(() => {
            const sel = document.getElementById('vcf-puzzle-select');
            return sel.options.length === window.GMK.VCFPractice.PUZZLES.length;
        });
        t.eq(consistent, true, '下拉选项数与题库一致');

        // 删此题：题库复原、下拉重建、按钮隐藏
        await page.evaluate(() => { document.getElementById('btn-vcf-del').click(); });
        const deleted = await page.evaluate(() => ({
            count: window.GMK.VCFPractice.PUZZLES.length,
            customs: window.GMK.VCFPractice.customCount(),
            delVisible: document.getElementById('btn-vcf-del').style.display !== 'none'
        }));
        t.eq(deleted.count, baseCount, '删除后题库复原', String(deleted.count));
        t.eq(deleted.customs, 0, '存档中自定义题清空');
        t.eq(deleted.delVisible, false, '删除后「删此题」隐藏');
    }
};
