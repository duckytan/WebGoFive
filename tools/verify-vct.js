/**
 * VCT 命中可靠性审计器
 *
 * 读 reports/vct-hits.json（ab-threat.js 落盘的命中局面），对每条快照做
 * **独立**验证：攻方按 TSS 首着走，防守方换用真正的引擎搜索（HARD，1s/手）
 * 自由防守 —— 攻方必须在 ≤8 手攻击内成五。防守方与 TSS 是两套独立代码路径，
 * 防守逃逸 = TSS 声明不可靠（误判），这是最硬的证据。
 *
 * 通过标准：全部快照验证成功（攻方成五）。任何一条逃逸都打印详细着法序列
 * 并让进程退出码 1。
 *
 * 运行：node tools/verify-vct.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

for (const f of ['constants', 'board', 'evaluator', 'search', 'kill', 'tss', 'forbidden']) {
    require(path.join(ENGINE, f + '.js'));
}
const EngineAI = require(path.join(ENGINE, 'gomoku-ai.js'));
require(path.join(ROOT, 'js', 'core', 'game.js'));
const GMK = globalThis.GMK;
const C = GMK.C;
const TSS = GMK.TSS;

const HIT_PATH = path.join(ROOT, 'reports', 'vct-hits.json');
const MAX_ATTACK_MOVES = 8;         // 攻方手数上限（TSS maxDepth 6 + 余量）
const DEFENDER_TIME = 1000;         // 防守方每手 1s（HARD），认真防

function name(x, y) { return String.fromCharCode(65 + x) + (y + 1); }

/**
 * 审计一条命中快照。
 * @returns {{ok: boolean, detail: string}}
 */
function verifyHit(hit, idx) {
    const g = new GMK.Game();
    g.loadCustomState({
        board: hit.board.map((r) => r.slice()),
        currentPlayer: hit.player,
        gameStatus: 'playing',
        moves: []
    });
    const attacker = hit.player;
    const defender = attacker === 1 ? 2 : 1;
    const hitBoard = hit.board.map((r) => r.slice());

    // 防守方：独立引擎，认真防守
    const defenderAI = new EngineAI(g);

    let guard = 0;
    const trace = [];
    while (g.gameStatus !== 'finished' && guard < MAX_ATTACK_MOVES * 2 + 2) {
        guard++;
        const p = g.currentPlayer;
        if (p === attacker) {
            const b = new GMK.Board();
            b.loadFrom2D(g.getBoardState());
            // 诊断预算拉满：这里要区分「预算不够」还是「真被逃逸」
            // ⚠ 必须与包装层命中时同预算：maxDepth 调深会让树爆炸，时间死线
            // 先到反而找不到浅层必胜 —— 「深」不是「超集」（第一版审计栽在这）
            const r = TSS.solve(b, p, { maxDepth: 6, nodeBudget: 60000, timeMs: 600 });
            if (!r || !C.inBoard(r.move)) {
                return { ok: false, detail: '第' + guard + '步：TSS 解不出后续（链断了）',
                    dump: { board: g.getBoardState(), hitBoard: hitBoard, player: p, trace: trace.slice() } };
            }
            const fr = g.placePiece(C.xOf(r.move), C.yOf(r.move));
            if (!fr || !fr.success) {
                return { ok: false, detail: '第' + guard + '步：TSS 着法非法（' + ((fr && fr.code) || '?') + '）',
                    dump: { board: g.getBoardState(), player: p, trace: trace.slice() } };
            }
            trace.push((p === 1 ? '黑' : '白') + name(C.xOf(r.move), C.yOf(r.move)) + '[T]');
        } else {
            const mv = defenderAI.getMove('HARD', { timeMs: DEFENDER_TIME });
            if (!mv) return { ok: false, detail: '第' + guard + '步：防守方无着法' };
            const r = g.placePiece(mv.x, mv.y);
            if (!r || !r.success) {
                return { ok: false, detail: '第' + guard + '步：防守着法非法（不应发生）' };
            }
            trace.push((p === 1 ? '黑' : '白') + name(mv.x, mv.y) + '[E]');
        }
    }
    if (g.gameStatus !== 'finished') {
        return { ok: false, detail: MAX_ATTACK_MOVES + ' 手攻击内未成五（防守逃逸）' };
    }
    if (g.winner !== attacker) {
        return { ok: false, detail: '攻方没赢（winner=' + g.winner + '）' };
    }
    return { ok: true, detail: g.moves.length + ' 手成五' };
}

function main() {
    if (!fs.existsSync(HIT_PATH)) {
        console.error('找不到 ' + HIT_PATH + ' —— 先跑 tools/ab-threat.js 生成命中快照');
        process.exit(2);
    }
    const data = JSON.parse(fs.readFileSync(HIT_PATH, 'utf8'));
    const hits = data.hits || [];
    console.log('VCT 可靠性审计：' + hits.length + ' 条命中快照（' + data.diff + '，防手=引擎 HARD ' +
        DEFENDER_TIME + 'ms/手）');
    if (hits.length === 0) { console.log('无快照可审 —— A/B 里 TSS 没命中过。'); return; }

    let okCount = 0;
    const bad = [];
    const dumps = [];
    hits.forEach((h, i) => {
        const r = verifyHit(h, i);
        if (r.ok) okCount++;
        else {
            bad.push({ idx: i, player: h.player, detail: r.detail });
            if (r.dump) dumps.push({ hit: i, player: h.player, board: r.dump.board, hitBoard: r.dump.hitBoard, playerToMove: r.dump.player, trace: r.dump.trace });
        }
        console.log('  #' + (i + 1) + ' 攻方=' + (h.player === 1 ? '黑' : '白') + ' → ' +
            (r.ok ? '✓ ' + r.detail : '✗ ' + r.detail));
    });
    if (dumps.length) {
        fs.writeFileSync(path.join(ROOT, 'reports', 'vct-fails.json'), JSON.stringify(dumps, null, 2));
        console.log('  失败局面 ' + dumps.length + ' 条 → reports/vct-fails.json');
    }
    console.log('─'.repeat(60));
    if (bad.length === 0) {
        console.log('审计结论：' + okCount + '/' + hits.length + ' 全部兑现 —— TSS 声明可靠');
    } else {
        console.log('审计结论：' + bad.length + ' 条声明未兑现（误判），明细：');
        bad.forEach((b) => console.log('  #' + b.idx + ' ' + b.detail));
        process.exit(1);
    }
}

main();
