/**
 * 验收闸门：单元 + E2E + 资源完整性 + 版本一致性
 * 用法：node tests/accept.js
 */
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let problems = [];

function check(name, fn) {
    try {
        const r = fn();
        console.log('  ✓ ' + name + (r ? '  [' + r + ']' : ''));
        return r;
    } catch (e) {
        problems.push(name + ': ' + e.message);
        console.log('  ✗ ' + name + '  [' + e.message + ']');
    }
}

console.log('\n=== 验收闸门 · ' + new Date().toISOString() + ' ===\n');

// 1. 单元测试（6 套引擎/装配/P2 逻辑）
console.log('— 单元测试（引擎 + 装配 + P2）—');
const unitSets = ['engine', 'forbidden', 'vcf', 'vcf-practice', 'search', 'loadorder', 'tunable', 'replay'];
let unitAssertions = 0;
for (const s of unitSets) {
    const out = execSync('node ' + path.join(ROOT, 'tests', 'engine', s + '.test.js'), { encoding: 'utf8', cwd: ROOT });
    const m = out.match(/全部通过[：:]\s*(\d+)\s*项|全部通过（[^）]*，(\d+)/);
    const n = m ? (parseInt(m[1] || m[2], 10)) : 0;
    unitAssertions += n;
    check('unit/' + s, () => { if (!out.includes('全部通过')) throw new Error('未全部通过'); });
}
console.log('  单元断言合计 ' + unitAssertions + ' 项');

// 2. E2E（9 套件，真实 Edge）
console.log('— E2E（真实 Edge 浏览器）—');
// run.js 失败时退出码非 0，execSync 会抛异常 —— 必须兜住，
// 否则 E2E 失败时整个闸门崩溃、连「判定：FAIL」都打不出来
let e2eOut = '';
try {
    e2eOut = execSync('node ' + path.join(ROOT, 'tests', 'e2e', 'run.js'), { encoding: 'utf8', cwd: ROOT, stdio: 'pipe' });
} catch (e) {
    e2eOut = (e.stdout || '') + '\n[E2E 退出码 ' + e.status + ']';
}
const e2eJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'e2e.json'), 'utf8'));
check('e2e 全绿', () => { if (e2eJson.fail > 0) throw new Error(e2eJson.fail + ' 项失败'); });
console.log('  E2E ' + e2eJson.pass + '/' + e2eJson.total + '（' + e2eJson.results.length + ' 套件）');

// 3. 资源完整性
console.log('— 资源完整性 —');
const needFiles = [
    'index.html', 'sw.js', 'manifest.webmanifest',
    'js/engine/constants.js', 'js/engine/board.js', 'js/engine/evaluator.js',
    'js/engine/search.js', 'js/engine/kill.js', 'js/engine/forbidden.js', 'js/engine/gomoku-ai.js',
    'js/core/game.js', 'js/renderer/board.js', 'js/ui/app.js',
    'js/app/save-load.js', 'js/app/replay.js', 'js/app/vcf.js', 'js/app/analysis.js', 'js/app/tunable-ai.js',
    'css/style.css', 'css/themes.css', 'css/animations.css',
    'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png'
];
check('全部关键文件存在', () => {
    const missing = needFiles.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) throw new Error('缺 ' + missing.join(', '));
});

// index.html 引用的 script 都存在
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
check('index.html 引用的 script 都存在', () => {
    const missing = refs.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) throw new Error('缺 ' + missing.join(', '));
});

// sw.js PRECACHE 清单里的文件必须真实存在：
// install 时 cache.addAll 对任何一个 404 都整体拒绝，SW 装不上、离线全失效
// （v2.0 交付时清单还是旧项目文件名，E2E 没盯住 —— 本闸门就是那次教训）
check('sw.js PRECACHE 清单文件都存在', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const m = /PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(sw);
    if (!m) throw new Error('sw.js 未找到 PRECACHE');
    const files = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).filter(f => f !== './');
    const missing = files.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) throw new Error('缺 ' + missing.join(', '));
});

// 4. 版本一致性
console.log('— 版本一致性 —');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
check('package.json version 非空', () => { if (!pkg.version) throw new Error('无 version'); });
check('manifest version 与 package 一致', () => {
    if (!mf.version) throw new Error('manifest 无 version 字段');
    if (mf.version !== pkg.version) throw new Error('manifest=' + mf.version + ' pkg=' + pkg.version);
    return mf.version;
});
// 标题处的版本号徽标是手写的，最容易和 package.json 漂移 —— 交给闸门盯着
check('index.html 标题版本号与 package 一致', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = /<span[^>]*id="app-version"[^>]*>\s*([^<]+?)\s*<\/span>/.exec(html);
    if (!m) throw new Error('index.html 缺少 #app-version');
    const shown = m[1].trim();
    if (shown !== 'v' + pkg.version) throw new Error('显示 ' + shown + '，期望 v' + pkg.version);
    return shown;
});
check('sw.js 缓存版本与 package 一致', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const m = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(sw);
    if (!m) throw new Error('sw.js 未找到 VERSION 常量');
    if (m[1] !== pkg.version) throw new Error('sw=' + m[1] + ' pkg=' + pkg.version);
    return m[1];
});

// 汇总
const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
const report = {
    generatedAt: new Date().toISOString(),
    verdict,
    unitAssertions,
    e2e: { pass: e2eJson.pass, fail: e2eJson.fail, total: e2eJson.total, suites: e2eJson.results.length },
    problems
};
fs.writeFileSync(path.join(ROOT, 'reports', 'acceptance.json'), JSON.stringify(report, null, 2));
console.log('\n=== 验收判定：' + verdict + '（问题 ' + problems.length + '）===');
if (problems.length) {
    problems.forEach(p => console.log('  - ' + p));
    process.exitCode = 1;
} else {
    console.log('  报告写入 reports/acceptance.json');
}
