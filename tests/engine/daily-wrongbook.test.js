/**
 * v2.5.0 新增能力单元测试：VCF 每日一题 / 错题本 / 深度评估调度层
 *
 * 覆盖：
 *   1. dateKey 本地时区格式（不能让 UTC 漂移进日期）
 *   2. dailyIndex 确定性（同日恒定）+ 范围合法 + 跨日分散
 *   3. recordDaily 连胜：首解 1、同日不叠加、连续日 +1、断档清零
 *      （「前一天」按被记录的 key 倒推 —— 修复过的语义，这里锁死）
 *   4. 错题本：最新在前、上限 50、清空
 *   5. DeepEval：Node 无 Worker → run() 走 sync 回退，结果与
 *      Analysis.evaluate 直连完全一致
 *
 * 运行：node tests/engine/daily-wrongbook.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
require(path.join(ENGINE, 'search.js'));
require(path.join(ENGINE, 'kill.js'));
require(path.join(ENGINE, 'forbidden.js'));
require(path.join(ENGINE, 'gomoku-ai.js'));
const VCF = require(path.join(ROOT, 'js', 'app', 'vcf.js'));
const Analysis = require(path.join(ROOT, 'js', 'app', 'analysis.js'));
const DeepEval = require(path.join(ROOT, 'js', 'app', 'deep-eval.js'));

const GMK = globalThis.GMK;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra === undefined ? '' : '  →  ' + extra));
}
function eq(a, b, name) { ok(a === b, name, '实际 ' + a + ' / 期望 ' + b); }

/* ---------------- 1. dateKey ---------------- */

{
    const d = new Date(2026, 9, 5);   // 2026-10-05 本地时区
    eq(VCF.dateKey(d), '2026-10-05', 'dateKey 单位数月/日补零');
    const d2 = new Date(2026, 11, 31);
    eq(VCF.dateKey(d2), '2026-12-31', 'dateKey 年末');
}

/* ---------------- 2. dailyIndex / daily ---------------- */

{
    const k1 = VCF.dateKey(new Date(2026, 9, 29));
    const k1b = VCF.dateKey(new Date(2026, 9, 29));
    eq(VCF.dailyIndex(k1), VCF.dailyIndex(k1b), '同一天选题确定性（两次构造同键）');
    const idx = VCF.dailyIndex(k1);
    ok(idx >= 0 && idx < VCF.PUZZLES.length, '选题索引落在题库范围内', String(idx));

    // 30 天内至少出现 3 道不同的题（哈希不至于塌缩到单点）
    const seen = new Set();
    for (let day = 1; day <= 30; day++) seen.add(VCF.dailyIndex(VCF.dateKey(new Date(2026, 9, day))));
    ok(seen.size >= 3, '跨日选题有分散性（30 天 ≥ 3 道不同题）', seen.size + ' 种');

    const daily = VCF.daily(k1);
    eq(daily.index, idx, 'daily() 返回的 index 与 dailyIndex 一致');
    ok(daily.puzzle && daily.puzzle.id, 'daily() 带出题目对象', JSON.stringify(daily.puzzle && daily.puzzle.id));
    eq(daily.solved, false, '未记录时 solved=false');
    eq(daily.streak, 0, '未记录时连胜=0');
}

/* ---------------- 3. recordDaily 连胜 ---------------- */

{
    VCF.clearProgress();
    eq(VCF.recordDaily('2026-10-01'), 1, '首解连胜=1');
    eq(VCF.recordDaily('2026-10-01'), 1, '同日重复通关不叠加');
    eq(VCF.daily('2026-10-01').solved, true, '记录后当天 solved=true');
    eq(VCF.recordDaily('2026-10-02'), 2, '连续第二天 +1');
    eq(VCF.recordDaily('2026-10-03'), 3, '连续第三天 +1');
    eq(VCF.recordDaily('2026-10-10'), 1, '断档后连胜清零重计');
    eq(VCF.recordDaily('2026-10-11'), 2, '重计后继续累积');
    // 跨月边界（10-31 的前一天是 10-30，11-01 的前一天是 10-31）
    VCF.clearProgress();
    eq(VCF.recordDaily('2026-10-31'), 1, '跨月前：月末首解');
    eq(VCF.recordDaily('2026-11-01'), 2, '跨月边界连续性（10-31 → 11-01）');
    VCF.clearProgress();
}

/* ---------------- 4. 错题本 ---------------- */

{
    VCF.clearProgress();
    VCF.wrongbookAdd('vcf-05', { x: 3, y: 7 }, 'not-four');
    VCF.wrongbookAdd('vcf-05', null, 'gave-up');
    VCF.wrongbookAdd('vcf-01', { x: 7, y: 7 }, 'dead');
    const list = VCF.wrongbookList();
    eq(list.length, 3, '错题本计数');
    eq(list[0].puzzle, 'vcf-01', '最新在前');
    ok(list.every((it) => it.at > 0), '每条带时间戳');
    eq(VCF.indexOf(list[0].puzzle) >= 0, true, '条目可反查题库');

    // 上限 50：灌 60 条只留最新 50
    for (let i = 0; i < 60; i++) VCF.wrongbookAdd('vcf-02', null, 'not-four');
    eq(VCF.wrongbookCount(), 50, '错题本上限 50');
    VCF.wrongbookClear();
    eq(VCF.wrongbookCount(), 0, '清空错题本');

    // clearProgress 一并清掉每日/错题（同一存档），两功能互不串档
    VCF.wrongbookAdd('vcf-03', { x: 1, y: 1 }, 'not-four');
    VCF.recordDaily('2026-10-01');
    VCF.clearProgress();
    eq(VCF.wrongbookCount(), 0, 'clearProgress 清错题本');
    eq(VCF.daily('2026-10-01').streak, 0, 'clearProgress 清连胜');
}

/* ---------------- 5. DeepEval 调度层 ---------------- */

{
    // Node 无 Worker：必须走 sync 回退，且结果与直连 Analysis.evaluate 一致
    eq(DeepEval.workerAvailable(), false, 'Node 环境无 Worker');

    const board = Array.from({ length: 15 }, () => new Array(15).fill(0));
    board[7][7] = 1; board[8][8] = 2; board[7][8] = 1;
    const opts = { timeMs: 120, depth: 4, candidates: 6 };

    const expect = Analysis.evaluate(board, 1, opts);
    DeepEval.run(board, 1, opts).then((res) => {
        eq(res.via, 'sync', '无 Worker 时 via=sync');
        ok(res.best && res.best.x >= 0, '回退路径给出最佳点', JSON.stringify(res.best));
        eq(res.best.x, expect.best.x, '回退结果与直连一致：best.x');
        eq(res.best.y, expect.best.y, '回退结果与直连一致：best.y');
        eq(res.ranking.length, expect.ranking.length, 'ranking 条数一致');
        finish();
    }).catch((e) => {
        ok(false, 'DeepEval.run 不应拒绝', String(e));
        finish();
    });

    function finish() {
        console.log('\n' + '─'.repeat(52));
        if (fail === 0) {
            console.log('✓ 全部通过：' + pass + ' 项');
            process.exit(0);
        } else {
            console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
            failures.forEach((f) => console.log('   · ' + f));
            process.exit(1);
        }
    }
}
