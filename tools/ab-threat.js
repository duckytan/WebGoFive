/**
 * ThreatAI A/B 对抗验证（v2.8.0 功能验收）
 *
 * 同一难度、同一时间预算下：「Threat 包装 AI」vs「裸引擎」交替先后手对弈。
 * 验收口径：
 *   · 双方零非法着法（非法 = bug，直接失败）
 *   · Threat 方胜率 ≥ 50%（TSS 前置只应帮忙不该拖累）
 *   · 统计 source='vct' 的命中次数与命中局的胜率（功能是否真的在起作用）
 *
 * 运行：
 *   node tools/ab-threat.js                       # HARD，8 局，默认时间配置
 *   node tools/ab-threat.js --diff=NORMAL --games=6 --time=300
 *
 * 注意：按墙钟计时，跑它的时候别并行别的 CPU 任务（v1 教训）。
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

for (const f of ['constants', 'board', 'evaluator', 'search', 'kill', 'tss', 'forbidden']) {
    require(path.join(ENGINE, f + '.js'));
}
const EngineAI = require(path.join(ENGINE, 'gomoku-ai.js'));
const GomokuGame = require(path.join(ROOT, 'js', 'core', 'game.js'));
const ThreatAI = require(path.join(ROOT, 'js', 'app', 'threat-ai.js'));

const GMK = globalThis.GMK;
const C = GMK.C;
const DIFFS = GMK.Game.DIFFS;

const MAX_MOVES = 300;

function parseArgs(list) {
    const out = {};
    for (const a of list) {
        const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
        if (!m) continue;
        out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}
function toInt(v, dft) {
    if (v === undefined || v === null || v === true) return dft;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dft;
}

const argv = parseArgs(process.argv.slice(2));
const GAMES = Math.max(2, toInt(argv.games, 8));
const DIFF = String(argv.diff || 'HARD').toUpperCase();
const TIME = toInt(argv.time, 0);
const VERBOSE = !!argv.verbose;
if (!DIFFS.includes(DIFF)) {
    console.error('未知难度：' + DIFF + '，可选 ' + DIFFS.join(' / '));
    process.exit(2);
}

function name(x, y) { return String.fromCharCode(65 + x) + (y + 1); }

/**
 * 跑一局。threatSide：Threat 方执 1（黑）还是 2（白）。
 * @returns {{winner:number, threatWin:boolean, moves:number, reason:string,
 *            vctHits:number, threatTime:number, bareTime:number, illegal:string|null}}
 */
function playGame(diff, threatSide) {
    const g = new GomokuGame();
    g.setGameMode('EvE');

    const bare = new EngineAI(g);
    const threat = ThreatAI.createWrapper(new EngineAI(g), { game: g });
    const aiOf = { [threatSide]: threat, [threatSide === 1 ? 2 : 1]: bare };

    let vctHits = 0;
    let threatTime = 0, bareTime = 0;
    let guard = 0;
    let illegal = null;
    const hitSnapshots = [];   // vct 命中时的局面快照（供 verify-vct 独立审计）

    while (g.gameStatus !== 'finished' && guard < MAX_MOVES) {
        guard++;
        const side = g.currentPlayer;
        const ai = aiOf[side];
        const t0 = Date.now();
        let mv = null;
        try {
            mv = ai.getMove(diff, TIME > 0 ? { timeMs: TIME } : undefined);
        } finally {
            const dt = Date.now() - t0;
            if (side === threatSide) threatTime += dt; else bareTime += dt;
        }
        const info = ai.getLastInfo();
        if (side === threatSide && info && info.source === 'vct') {
            vctHits++;
            hitSnapshots.push({ player: side, board: g.getBoardState() });
        }

        if (!mv || typeof mv.x !== 'number') {
            return { winner: threatSide === 1 ? 2 : 1, threatWin: false, moves: g.moves.length,
                reason: 'no-move', vctHits, threatTime, bareTime, illegal: 'no-move', hitSnapshots };
        }
        const r = g.placePiece(mv.x, mv.y);
        if (!r || !r.success) {
            illegal = (r && r.code) + '@' + mv.x + ',' + mv.y;
            if (VERBOSE) console.log('    ✗ 非法：' + illegal);
            return { winner: side === 1 ? 2 : 1, threatWin: false, moves: g.moves.length,
                reason: 'illegal', vctHits, threatTime, bareTime, illegal, hitSnapshots };
        }
        if (VERBOSE) {
            console.log('  ' + String(g.moves.length).padStart(3) + '. ' +
                (side === 1 ? '黑' : '白') + (side === threatSide ? '[T]' : '[E]') + ' ' +
                name(mv.x, mv.y) + (info ? '  ' + String(info.source || '-').padEnd(6) : ''));
        }
    }

    if (g.gameStatus !== 'finished') {
        return { winner: 0, threatWin: false, moves: g.moves.length, reason: 'too-long',
            vctHits, threatTime, bareTime, illegal: null, hitSnapshots };
    }
    return {
        winner: g.winner,
        threatWin: g.winner === threatSide,
        moves: g.moves.length,
        reason: g.winner === 0 ? 'draw' : 'five',
        vctHits, threatTime, bareTime, illegal: null, hitSnapshots
    };
}

function main() {
    console.log('ThreatAI A/B：' + DIFF + ' vs ' + DIFF + '（Threat[T] vs 裸引擎[E]），' +
        GAMES + ' 局' + (TIME > 0 ? '，单步限时 ' + TIME + 'ms' : '，用难度默认配置'));
    console.log('交替换边：偶数局 Threat 执黑，奇数局 Threat 执白');
    console.log('─'.repeat(60));

    let threatWins = 0, bareWins = 0, draws = 0;
    let vctTotal = 0, vctWinGames = 0, vctHitGames = 0;
    let movesSum = 0, threatTimeSum = 0, bareTimeSum = 0;
    let illegalCount = 0;
    const allHits = [];

    for (let k = 0; k < GAMES; k++) {
        const threatSide = k % 2 === 0 ? 1 : 2;
        const r = playGame(DIFF, threatSide);
        for (const h of r.hitSnapshots || []) allHits.push(h);
        if (r.threatWin) threatWins++;
        else if (r.winner === threatSide) { /* never */ }
        else if (r.winner === 0) draws++;
        else bareWins++;
        if (r.illegal) illegalCount++;
        movesSum += r.moves;
        threatTimeSum += r.threatTime;
        bareTimeSum += r.bareTime;
        vctTotal += r.vctHits;
        if (r.vctHits > 0) { vctHitGames++; if (r.threatWin) vctWinGames++; }
        console.log('  局' + (k + 1) + '：Threat 执' + (threatSide === 1 ? '黑' : '白') +
            ' → ' + (r.winner === 0 ? '平局' : (r.threatWin ? 'Threat 胜' : '裸引擎胜')) +
            '（' + r.reason + '，' + r.moves + ' 手，vct 命中 ' + r.vctHits + ' 次）');
    }

    console.log('─'.repeat(60));
    const decided = threatWins + bareWins;
    const rate = decided ? Math.round(threatWins / decided * 100) : 0;
    console.log('  Threat ' + threatWins + ' 胜 / 裸引擎 ' + bareWins + ' 胜 / 平 ' + draws +
        '  → Threat 胜率 ' + rate + '%（分出胜负的对局）');
    console.log('  vct 命中：' + vctTotal + ' 手，分布在 ' + vctHitGames + ' 局（其中 ' +
        vctWinGames + ' 局获胜）');
    console.log('  平均手数 ' + Math.round(movesSum / GAMES) +
        '，Threat 总耗时 ' + (threatTimeSum / 1000).toFixed(1) + 's vs 裸引擎 ' +
        (bareTimeSum / 1000).toFixed(1) + 's');
    console.log('  非法着法：' + illegalCount + '（必须为 0）');
    // 命中局面落盘，供 tools/verify-vct.js 用独立引擎做可靠性审计
    const fs = require('fs');
    const outPath = path.join(__dirname, '..', 'reports', 'vct-hits.json');
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), diff: DIFF, hits: allHits }, null, 2));
    console.log('  vct 命中快照 ' + allHits.length + ' 条 → ' + outPath);
    if (illegalCount > 0) process.exit(1);
}

main();
