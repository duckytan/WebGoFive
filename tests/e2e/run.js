/**
 * E2E 入口：跑全部（或指定编号）套件，结果写 reports/e2e.json
 * 用法：node tests/e2e/run.js [01] [02] ...
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { boot, shutdown, runSuite, ROOT } = require('./harness');

const SUITES = [
    '01-load', '02-rules', '03-ai', '04-modes',
    '05-settings', '06-persistence', '07-mobile', '08-pwa',
    '09-ai-panel', '10-strength-opening'
];

(async () => {
    const want = process.argv.slice(2);
    const todo = want.length ? SUITES.filter(s => want.some(w => s.includes(w))) : SUITES;

    await boot();
    const results = [];
    let totalPass = 0, totalFail = 0;

    for (const name of todo) {
        const mod = require('./suites/' + name);
        const t = await runSuite(name, mod.run);
        results.push({ suite: name, pass: t.pass, fail: t.fail, failures: t.failures });
        totalPass += t.pass; totalFail += t.fail;
    }

    await shutdown();

    const out = {
        generatedAt: new Date().toISOString(),
        browser: process.env.EDGE_PATH || '(local Edge)',
        pass: totalPass, fail: totalFail, total: totalPass + totalFail,
        results
    };
    const repDir = path.join(ROOT, 'reports');
    fs.mkdirSync(repDir, { recursive: true });
    fs.writeFileSync(path.join(repDir, 'e2e.json'), JSON.stringify(out, null, 2));
    console.log('\n=== E2E ' + totalPass + ' 通过 / ' + totalFail + ' 失败（' + todo.length + ' 套件） ===');
    process.exitCode = totalFail > 0 ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
