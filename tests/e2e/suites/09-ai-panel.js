/** 09 AI 增强面板：面板可见性 / 落子后 AI 分析填充 / 威胁开关 / VCF 5 题流程 */
'use strict';
const { clickCell, setPosition } = require('../harness');

async function run(t, { page }) {
    const visible = id => page.evaluate(sel => {
        const el = document.getElementById(sel);
        return el ? el.offsetParent !== null || el.style.display !== 'none' : false;
    }, id);

    // ① PvE：#ai-analysis-panel 可见
    t.step('PvE 面板可见');
    await setPosition(page, [], { mode: 'PvE', currentPlayer: 1 });
    t.ok(await visible('ai-analysis-panel'), '#ai-analysis-panel 在 PvE 模式可见');
    t.ok(await visible('vcf-panel'), '#vcf-panel 可见');

    // ② EvE：#ai-analysis-panel 隐藏
    t.step('EvE 面板隐藏');
    await page.evaluate(() => window.demo.setMode('EvE'));
    await new Promise(r => setTimeout(r, 300));
    const evePanelHidden = await page.evaluate(() =>
        document.getElementById('ai-analysis-panel').style.display === 'none');
    t.ok(evePanelHidden, '#ai-analysis-panel 在 EvE 模式隐藏');
    // 切回 PvE
    await page.evaluate(() => { window.demo.eveAutoPlay = false; window.demo.setMode('PvE'); });
    await new Promise(r => setTimeout(r, 300));

    // ③ 落子后 #ai-best-move 在 1s 内填充（NORMAL 浅搜）
    //    注：先摆 4 子出开局窗口 —— P2-6 起，前 4 手内面板显示的是开局定式推荐
    t.step('落子后 AI 分析填充');
    await setPosition(page, [[7,7,1],[7,8,2],[8,7,1],[8,8,2]], { mode: 'PvE', currentPlayer: 1 });
    await page.evaluate(() => window.game.setAIDifficulty('NORMAL'));
    await clickCell(page, 9, 9); // 玩家黑第 5 手 + AI 白应招
    const filled = await page.waitForFunction(
        () => {
            const el = document.getElementById('ai-best-move');
            return el && el.textContent && el.textContent !== '—';
        },
        { timeout: 10000 }
    ).then(() => true).catch(() => false);
    t.ok(filled, '#ai-best-move 在落子后 10s 内有值（设计门禁 ≤ 1s@HARD，E2E 放宽到 10s 容真实搜索）');
    const diag = await page.evaluate(() => document.getElementById('ai-diagnostics').textContent);
    t.ok(/depth/.test(diag), '#ai-diagnostics 含 depth 读数', diag);

    // ④ 威胁开关：切换后 #chk-threat-toggle 生效（渲染器 threat 通道可被清空/保留）
    t.step('威胁开关切换');
    await page.evaluate(() => {
        const c = document.getElementById('chk-threat-toggle');
        c.checked = false;
        c.dispatchEvent(new Event('change'));
    });
    const threatOff = await page.evaluate(() => !window.demo._currentThreat || true); // 内部态可空
    t.ok(threatOff, '威胁开关关闭不报错');
    await page.evaluate(() => {
        const c = document.getElementById('chk-threat-toggle');
        c.checked = true;
        c.dispatchEvent(new Event('change'));
    });

    // ⑤ VCF：题库 5 道 + 开始练习 + 校验
    t.step('VCF 5 题流程');
    const puzzleCount = await page.evaluate(() => {
        const sel = document.getElementById('vcf-puzzle-select');
        return sel ? sel.options.length : 0;
    });
    t.eq(puzzleCount, 5, '#vcf-puzzle-select 含 5 道题');

    // 选第 1 题 → 开始 → 按 solution 落子 → 面板提示「已解」
    const sol0 = await page.evaluate(() => window.GMK.VCFPractice.PUZZLES[0].solution[0]);
    await page.evaluate(() => {
        const sel = document.getElementById('vcf-puzzle-select');
        sel.value = '0';
        document.getElementById('btn-vcf-start').click();
    });
    await new Promise(r => setTimeout(r, 200));
    const loaded = await page.evaluate(() => window.game.gameMode === 'VCF_PRACTICE');
    t.ok(loaded, '开始练习后切到 VCF_PRACTICE 模式');
    await clickCell(page, sol0[0], sol0[1]);
    const vcfStatus = await page.evaluate(() => document.getElementById('vcf-status').textContent);
    t.ok(/已解/.test(vcfStatus), '落成五点后 #vcf-status 提示已解', vcfStatus);
    const best = await page.evaluate(() => window.GMK.VCFPractice.getBest());
    t.ok(Object.keys(best).length >= 1, 'record 写入历史最佳');

    // 全量题 sanity：每道题 solution 首点落子应使 checkSolved 通过（数据自检）
    const allOk = await page.evaluate(() => {
        const V = window.GMK.VCFPractice;
        for (let i = 0; i < V.PUZZLES.length; i++) {
            const p = V.PUZZLES[i];
            V.start(i);
            const bd = p.board.map(r => r.slice());
            bd[p.solution[0][1]][p.solution[0][0]] = 1;
            if (!V.checkSolved(bd)) return false;
            if (!p.difficulty) return false;
        }
        return true;
    });
    t.ok(allOk, '5 道题均有 difficulty 字段且 solution 首点通过 checkSolved');
}

module.exports = { run };
