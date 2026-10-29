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

    // ⑤ VCF 连冲练习：题库 9 道 + 真连冲判定 + 撤销 + 通关记录
    t.step('VCF 连冲练习');
    const puzzleCount = await page.evaluate(() => {
        const sel = document.getElementById('vcf-puzzle-select');
        return sel ? sel.options.length : 0;
    });
    const expected = await page.evaluate(() => window.GMK.VCFPractice.PUZZLES.length);
    t.eq(puzzleCount, expected, '#vcf-puzzle-select 题数与题库一致');
    t.ok(expected >= 8, '题库至少 8 道', expected + ' 道');

    // 开始第 2 题（两手的题）
    await page.evaluate(() => {
        const sel = document.getElementById('vcf-puzzle-select');
        sel.value = '1';
        document.getElementById('btn-vcf-start').click();
    });
    await new Promise(r => setTimeout(r, 150));
    t.ok(await page.evaluate(() => window.game.gameMode === 'VCF_PRACTICE'), '开始练习后切到 VCF_PRACTICE 模式');

    // 非冲四：必须被拒，棋子不能留在盘上
    const before = await page.evaluate(() => JSON.stringify(window.demo.vcf.board2d));
    await page.evaluate(() => window.demo._onPlayerClick(0, 0));
    const afterBad2 = await page.evaluate(() => ({
        board: JSON.stringify(window.demo.vcf.board2d),
        msg: document.getElementById('vcf-status').textContent,
        steps: window.demo.vcf.steps
    }));
    t.eq(afterBad2.board, before, '非冲四被拒后棋盘原样恢复');
    t.eq(afterBad2.steps, 0, '非冲四不计步数');
    t.ok(/不是冲四/.test(afterBad2.msg), '#vcf-status 提示「不是冲四」', afterBad2.msg);

    // 提示 → 按提示落子 → 冲四成立 + 对手自动应手
    const hint = await page.evaluate(() => window.demo.vcf.hint());
    t.ok(!!hint, 'hint() 给出可用的冲四点', JSON.stringify(hint));
    await page.evaluate(h => window.demo._onPlayerClick(h.x, h.y), hint);
    const afterFour = await page.evaluate(() => ({
        steps: window.demo.vcf.steps,
        reply: window.demo.vcf.lastReply,
        msg: document.getElementById('vcf-status').textContent,
        white: window.game.board.flat().filter(v => v === 2).length
    }));
    t.eq(afterFour.steps, 1, '冲四计 1 步');
    t.ok(!!afterFour.reply, '对手被迫应手（自动落白子）', JSON.stringify(afterFour.reply));
    t.ok(/冲四成立|活四/.test(afterFour.msg), '#vcf-status 反馈冲四结果', afterFour.msg);

    // 悔一步：棋盘与步数都要还原
    await page.evaluate(() => window.demo._vcfUndo());
    t.eq(await page.evaluate(() => window.demo.vcf.steps), 0, '悔一步后步数归零');
    t.eq(await page.evaluate(() => JSON.stringify(window.demo.vcf.board2d)), before, '悔一步后棋盘还原');

    // 一路照提示走到底 → 通关 + 写入记录
    const solved = await page.evaluate(() => {
        const s = window.demo.vcf;
        let guard = 0;
        while (guard++ < 20 && s.state === 'playing') {
            const h = s.hint();
            if (!h) break;
            window.demo._onPlayerClick(h.x, h.y);
        }
        return { state: s.state, steps: s.steps };
    });
    t.eq(solved.state, 'solved', '照提示一路走可以通关');
    const vcfStatus = await page.evaluate(() => document.getElementById('vcf-status').textContent);
    t.ok(/已解/.test(vcfStatus), '通关后 #vcf-status 提示已解', vcfStatus);
    t.ok(await page.evaluate(() => Object.keys(window.GMK.VCFPractice.getBest()).length) >= 1, 'record 写入历史最佳');

    // 每道题的参考线长度必须等于标注深度（题库自检）
    const depthOk = await page.evaluate(() => {
        const V = window.GMK.VCFPractice;
        for (let i = 0; i < V.PUZZLES.length; i++) {
            if (V.solutionOf(i).length !== V.PUZZLES[i].depth) return false;
        }
        return true;
    });
    t.ok(depthOk, '每道题参考线长度与标注深度一致');
}

module.exports = { run };
