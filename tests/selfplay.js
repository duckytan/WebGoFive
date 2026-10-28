/**
 * 自对弈验证 —— 难度对抗（v2）
 *
 * v1 的版本是「新引擎 vs AdvancedAI」，用来证明重写后的引擎更强。
 * v2 已经把 AdvancedAI 整个删掉了（棋力全部收敛到 js/engine），
 * 所以这里换成**难度对抗**：用同一个引擎的不同难度配置互打，
 * 验证「难度档位真的是棋力梯度，而不是只有思考时间不一样」。
 *
 * 运行：
 *   node tests/selfplay.js                              # 默认 6 局，HELL vs NORMAL
 *   node tests/selfplay.js --games=2 --time=200         # 快速冒烟
 *   node tests/selfplay.js --black=HARD --white=NORMAL  # 指定双方难度
 *   node tests/selfplay.js --time=400 --verbose         # 限时 + 逐步打印
 *
 * 参数：
 *   --games=N     局数，默认 6
 *   --black=D     偶数局执黑的难度，默认 HELL（即「强方」）
 *   --white=D     偶数局执白的难度，默认 NORMAL
 *   --time=MS     单步思考上限；0/缺省 = 用该难度的默认配置
 *   --verbose     逐步打印每一手
 *
 * 两点设计说明：
 *  1. 交替换边（偶数局 强方执黑，奇数局 强方执白），抵消先手优势。
 *  2. 落子一律走 GomokuGame.placePiece，也就是**真实的 v2 规则**（含黑棋
 *     RIF 禁手判定）。引擎一旦给出非法着法（含禁手点、已占点、越界），
 *     这里会立刻抓出来并让进程以退出码 1 结束 —— 那是必须修的 bug，
 *     不是概率问题，所以不做「重试」。
 *
 * @module tests/selfplay
 */

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

// 引擎模块有严格加载顺序：constants 提供 C，board/evaluator 依赖 C，
// search 依赖 board+evaluator，kill 依赖 board，forbidden 依赖 board。
// gomoku-ai 是接入层，放最后。core/game 构造时会读 GMK.Forbidden，
// 因此必须排在 forbidden 之后 require。
for (const f of ['constants', 'board', 'evaluator', 'search', 'kill', 'forbidden']) {
    require(path.join(ENGINE, f + '.js'));
}
const EngineAI = require(path.join(ENGINE, 'gomoku-ai.js'));
const GomokuGame = require(path.join(ROOT, 'js', 'core', 'game.js'));

const C = globalThis.GMK.C;
const DIFFS = globalThis.GMK.Game.DIFFS;

/** 单局硬上限手数：15×15 满盘 225 手，留余量防死循环 */
const MAX_MOVES = 300;

/* ---------------- 参数解析 ---------------- */

/**
 * 解析 `--key=value` / `--flag` 形式的命令行参数。
 * @param {string[]} list argv 切片
 * @returns {Object<string, string|true>}
 */
function parseArgs(list) {
    const out = {};
    for (const a of list) {
        const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
        if (!m) continue;
        out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

/**
 * 解析非负整数参数，非法时回落默认值。
 * @param {*} v 原始值
 * @param {number} dft 默认值
 * @returns {number}
 */
function toInt(v, dft) {
    if (v === undefined || v === null || v === true) return dft;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dft;
}

/**
 * 校验难度名（v2 只有 BEGINNER / NORMAL / HARD / HELL）。
 * @param {*} v 原始值
 * @param {string} dft 默认难度
 * @returns {string}
 */
function pickDiff(v, dft) {
    const d = String(v === undefined || v === true ? dft : v).toUpperCase();
    if (!DIFFS.includes(d)) {
        console.error('未知难度：' + v + '，可选 ' + DIFFS.join(' / '));
        process.exit(2);
    }
    return d;
}

const argv = parseArgs(process.argv.slice(2));
const GAMES = Math.max(1, toInt(argv.games, 6));
const STRONG_DIFF = pickDiff(argv.black, 'HELL');
const WEAK_DIFF = pickDiff(argv.white, 'NORMAL');
const TIME = toInt(argv.time, 0);
const VERBOSE = !!argv.verbose;

/* ---------------- 工具 ---------------- */

/** 棋盘坐标 → 人类可读坐标（A1..O15） */
function name(x, y) {
    return String.fromCharCode(65 + x) + (y + 1);
}

/** 平均值（保留 0 位小数），分母为 0 时返回 0 */
function avg(sum, n) {
    return n > 0 ? Math.round(sum / n) : 0;
}

/* ---------------- 单局 ---------------- */

/**
 * 跑一局。两个 EngineAI 实例挂在同一个 game 上：
 * EngineAI.getMove 每次都会先 sync() 拉取 game.board，所以共享实例是安全的。
 *
 * @param {string} blackDiff 黑方难度
 * @param {string} whiteDiff 白方难度
 * @returns {{
 *   winner: number, moves: number, reason: string,
 *   times: {1:number,2:number}, sideMoves: {1:number,2:number},
 *   illegal: Array<{step:number, side:number, diff:string, tag:string}>
 * }}
 */
function playGame(blackDiff, whiteDiff) {
    const g = new GomokuGame();
    g.setGameMode('EvE');           // 只是语义标记，AI 由本脚本直接驱动

    const ais = { 1: new EngineAI(g), 2: new EngineAI(g) };
    const diffOf = { 1: blackDiff, 2: whiteDiff };
    const times = { 1: 0, 2: 0 };
    const sideMoves = { 1: 0, 2: 0 };
    const illegal = [];

    let guard = 0;
    let reason = '';

    while (g.gameStatus !== 'finished' && guard < MAX_MOVES) {
        guard++;

        const side = g.currentPlayer;
        const ai = ais[side];
        const diff = diffOf[side];

        const t0 = Date.now();
        let mv = null;
        try {
            mv = TIME > 0 ? ai.getMove(diff, { timeMs: TIME }) : ai.getMove(diff);
        } finally {
            // 即便 getMove 抛异常也要把耗时计入，否则统计会偏乐观
            times[side] += Date.now() - t0;
        }
        sideMoves[side]++;

        if (!mv || typeof mv.x !== 'number' || typeof mv.y !== 'number') {
            return { winner: 0, moves: g.moves.length, reason: 'no-move', times, sideMoves, illegal };
        }

        const r = g.placePiece(mv.x, mv.y);

        if (!r || !r.success) {
            // 引擎下了非法着法：记录后立刻中止该局（不重试，重试会掩盖 bug）
            const tag = 'illegal:' + ((r && r.code) || 'UNKNOWN') + '@' + mv.x + ',' + mv.y;
            illegal.push({ step: g.moves.length + 1, side, diff, tag });
            if (VERBOSE) {
                console.log('    ✗ 第 ' + (g.moves.length + 1) + ' 手 ' +
                    (side === 1 ? '黑' : '白') + '(' + diff + ') ' +
                    name(mv.x, mv.y) + ' 非法：' + tag);
            }
            return { winner: side === 1 ? 2 : 1, moves: g.moves.length, reason: tag, times, sideMoves, illegal };
        }

        if (VERBOSE) {
            const info = ai.getLastInfo();
            const diag = info
                ? '  ' + String(info.source || '-').padEnd(6) +
                  ' d' + String(info.depth || 0).padStart(2) +
                  ' n' + String(info.nodes || 0).padStart(7) +
                  ' ' + String(info.timeMs || 0).padStart(5) + 'ms'
                : '';
            console.log('  ' + String(g.moves.length).padStart(3) + '. ' +
                (side === 1 ? '黑' : '白') + '(' + diff + ') ' +
                name(mv.x, mv.y) + diag);
        }
    }

    if (g.gameStatus !== 'finished') {
        // 300 手还没结束：真实对局不可能这样，说明双方在无效周旋
        return { winner: 0, moves: g.moves.length, reason: 'too-long', times, sideMoves, illegal };
    }
    // winner 可能是 0（225 手满盘无五连 = 平局），不能一律当五连
    return {
        winner: g.winner,
        moves: g.moves.length,
        reason: g.winner === 0 ? 'draw' : 'five',
        times,
        sideMoves,
        illegal
    };
}

/* ---------------- 对局编排 ---------------- */

function main() {
    const limitNote = TIME > 0 ? '，单步限时 ' + TIME + 'ms' : '，用各难度默认思考配置';
    console.log('自对弈（难度对抗）：' + STRONG_DIFF + ' vs ' + WEAK_DIFF +
        '，共 ' + GAMES + ' 局' + limitNote);
    console.log('交替换边：偶数局 ' + STRONG_DIFF + ' 执黑，奇数局 ' + STRONG_DIFF + ' 执白');
    console.log('');

    const stat = {
        strongWin: 0, weakWin: 0, draw: 0,
        illegal: 0, noMove: 0, tooLong: 0,
        moves: 0,
        strongTime: 0, weakTime: 0,
        strongMoves: 0, weakMoves: 0,
        illegalDetail: []
    };

    for (let k = 0; k < GAMES; k++) {
        const strongIsBlack = (k % 2 === 0);
        const blackDiff = strongIsBlack ? STRONG_DIFF : WEAK_DIFF;
        const whiteDiff = strongIsBlack ? WEAK_DIFF : STRONG_DIFF;

        const res = playGame(blackDiff, whiteDiff);

        // 归因：winner=1 是黑胜，winner=2 是白胜
        let tag;
        if (res.winner === 0) { stat.draw++; tag = res.reason === 'too-long' ? '超时未终局' : '和'; }
        else if ((res.winner === 1) === strongIsBlack) { stat.strongWin++; tag = STRONG_DIFF + ' 胜'; }
        else { stat.weakWin++; tag = WEAK_DIFF + ' 胜'; }

        stat.moves += res.moves;
        if (res.reason.indexOf('illegal:') === 0) {
            stat.illegal++;
            for (const it of res.illegal) stat.illegalDetail.push(it.tag + ' @局' + (k + 1));
        }
        if (res.reason === 'no-move') stat.noMove++;
        if (res.reason === 'too-long') stat.tooLong++;

        const strongSide = strongIsBlack ? 1 : 2;
        const weakSide = strongIsBlack ? 2 : 1;
        stat.strongTime += res.times[strongSide];
        stat.weakTime += res.times[weakSide];
        stat.strongMoves += res.sideMoves[strongSide];
        stat.weakMoves += res.sideMoves[weakSide];

        console.log('  #' + (k + 1) + '  黑=' + blackDiff + ' 白=' + whiteDiff +
            '  →  ' + tag + '  ' + res.moves + ' 手  (' + res.reason + ')  ' +
            avg(res.times[strongSide], res.sideMoves[strongSide]) + 'ms/步 vs ' +
            avg(res.times[weakSide], res.sideMoves[weakSide]) + 'ms/步');
    }

    const total = stat.strongWin + stat.weakWin + stat.draw;
    const rate = total ? (stat.strongWin / total * 100).toFixed(1) : '0.0';

    console.log('');
    console.log('─'.repeat(62));
    console.log(STRONG_DIFF + ' 胜 ' + stat.strongWin +
        '   平 ' + stat.draw +
        '   ' + WEAK_DIFF + ' 胜 ' + stat.weakWin);
    console.log(STRONG_DIFF + ' 胜率 ' + rate + '%（分母 ' + total + ' 局，含平局）');
    console.log('平均每局 ' + (stat.moves / Math.max(total, 1)).toFixed(1) + ' 手');
    console.log(STRONG_DIFF + ' 平均每步 ' + avg(stat.strongTime, stat.strongMoves) + 'ms' +
        '   ' + WEAK_DIFF + ' 平均每步 ' + avg(stat.weakTime, stat.weakMoves) + 'ms');
    console.log('非法着法 ' + stat.illegal + ' 次' +
        (stat.noMove ? '   ⚠ 引擎未给出着法 ' + stat.noMove + ' 次' : '') +
        (stat.tooLong ? '   ⚠ 超过 ' + MAX_MOVES + ' 手未终局 ' + stat.tooLong + ' 次' : ''));
    if (stat.illegalDetail.length) {
        for (const d of stat.illegalDetail) console.log('    ✗ ' + d);
    }
    console.log('─'.repeat(62));

    // 出现任何非法着法都算失败：那是必须修掉的 bug，不是概率问题
    process.exitCode = stat.illegal ? 1 : 0;
}

main();
