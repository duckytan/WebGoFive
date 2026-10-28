/**
 * 单局复盘工具（v2）
 *
 * 自对弈只告诉你「谁赢了」，这个脚本告诉你「怎么赢的」——
 * 每一手的搜索深度、节点数、评分、来源（成五/挡五/VCF/搜索），
 * 外加终局棋盘。调棋力问题时先看这个，比看胜率有用得多。
 *
 * 运行：
 *   node tests/showgame.js                          # 黑=HARD 白=NORMAL
 *   node tests/showgame.js --black=HELL --white=HARD
 *   node tests/showgame.js --time=200               # 单步限时 200ms
 *   node tests/showgame.js --black=NORMAL --white=NORMAL --time=300
 *
 * 参数：
 *   --black=D   黑方难度，默认 HARD
 *   --white=D   白方难度，默认 NORMAL
 *   --time=MS   单步思考上限；0/缺省 = 用该难度默认配置
 *
 * 两个 EngineAI 实例挂在同一个 GomokuGame 上：EngineAI.getMove 每次
 * 都会先 sync() 把 game.board 搬进引擎棋盘，所以共享 game 是安全的，
 * 这正是 v2 自对弈/演示要用的方式。
 *
 * @module tests/showgame
 */

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'js', 'engine');

// 加载顺序：constants → board → evaluator → search → kill → forbidden → gomoku-ai，
// 最后才是 core/game（其构造函数要读 GMK.Forbidden）。
for (const f of ['constants', 'board', 'evaluator', 'search', 'kill', 'forbidden']) {
    require(path.join(ENGINE, f + '.js'));
}
const EngineAI = require(path.join(ENGINE, 'gomoku-ai.js'));
const GomokuGame = require(path.join(ROOT, 'js', 'core', 'game.js'));

const C = globalThis.GMK.C;
const DIFFS = globalThis.GMK.Game.DIFFS;
const SIZE = globalThis.GMK.Game.SIZE;

/** 单局硬上限手数（满盘 225 手，留余量防死循环） */
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
const BLACK_DIFF = pickDiff(argv.black, 'HARD');
const WHITE_DIFF = pickDiff(argv.white, 'NORMAL');
const TIME = toInt(argv.time, 0);

/* ---------------- 工具 ---------------- */

/** 棋盘坐标 → 人类可读坐标（A1..O15） */
function name(x, y) {
    return String.fromCharCode(65 + x) + (y + 1);
}

/** 把 info 里的填充索引翻译成坐标名；非法索引返回 '--' */
function nameOfIdx(idx) {
    if (typeof idx !== 'number' || idx < 0 || !C.inBoard(idx)) return '--';
    return name(C.xOf(idx), C.yOf(idx));
}

/**
 * 渲染 15×15 ASCII 棋盘。
 * @param {number[][]} board board[y][x]，0=空 1=黑 2=白
 * @returns {string} 多行文本
 */
function renderBoard(board) {
    const glyph = ['.', 'X', 'O'];
    const lines = [];
    lines.push('    ' + Array.from({ length: SIZE }, (_, i) => String.fromCharCode(65 + i)).join(' '));
    for (let y = 0; y < SIZE; y++) {
        let row = String(y + 1).padStart(3) + ' ';
        for (let x = 0; x < SIZE; x++) row += glyph[board[y][x] || 0] + ' ';
        lines.push(row);
    }
    return lines.join('\n');
}

/* ---------------- 对局 ---------------- */

function main() {
    const g = new GomokuGame();
    g.setGameMode('EvE');

    const ais = { 1: new EngineAI(g), 2: new EngineAI(g) };
    const diffOf = { 1: BLACK_DIFF, 2: WHITE_DIFF };

    const limitNote = TIME > 0 ? '单步限时 ' + TIME + 'ms' : '各难度默认配置';
    console.log('='.repeat(72));
    console.log('单局演示：黑=' + BLACK_DIFF + '   白=' + WHITE_DIFF + '   ' + limitNote);
    console.log('='.repeat(72));

    let illegal = null;
    let guard = 0;
    let totalMs = 0;

    while (g.gameStatus !== 'finished' && guard < MAX_MOVES) {
        guard++;

        const side = g.currentPlayer;
        const ai = ais[side];
        const diff = diffOf[side];

        const mv = TIME > 0 ? ai.getMove(diff, { timeMs: TIME }) : ai.getMove(diff);

        if (!mv || typeof mv.x !== 'number' || typeof mv.y !== 'number') {
            console.log('  ✗ 引擎（' + diff + '）没有给出着法，演示中止');
            illegal = { code: 'NO_MOVE', x: -1, y: -1 };
            break;
        }

        const info = ai.getLastInfo();
        totalMs += info ? (info.timeMs || 0) : 0;

        const r = g.placePiece(mv.x, mv.y);

        // 每步一行：手数 / 执子方 / 坐标 / 诊断（有就打印，没有就省略）
        let line = '  ' + String(g.moves.length || (guard)).padStart(3) + '. ' +
            (side === 1 ? '黑' : '白') + '(' + diff + ') ' +
            (name(mv.x, mv.y) + '  ').padEnd(4);

        if (info) {
            line += String(info.source || '-').padEnd(7) +
                ' d' + String(info.depth || 0).padStart(2) +
                '  n' + String(info.nodes || 0).padStart(7) +
                '  s' + String(Math.round(info.score || 0)).padStart(9) +
                '  ' + String(info.timeMs || 0).padStart(5) + 'ms';
        }
        if (!r || !r.success) {
            line += '   ✗ 非法（' + ((r && r.code) || 'UNKNOWN') + '）';
            illegal = { code: (r && r.code) || 'UNKNOWN', x: mv.x, y: mv.y };
        }
        console.log(line);

        if (illegal) break;
    }

    /* ---------------- 结果 ---------------- */
    let verdict;
    if (illegal) {
        verdict = '非法着法（' + illegal.code + ' @' +
            (illegal.x >= 0 ? name(illegal.x, illegal.y) : '—') + '）';
    } else if (g.gameStatus !== 'finished') {
        verdict = '未终局（超过 ' + MAX_MOVES + ' 手）';
    } else if (g.winner === 0) {
        verdict = '和棋';
    } else {
        verdict = (g.winner === 1 ? '黑胜' : '白胜') + '（五连）';
    }

    console.log('');
    console.log('─'.repeat(72));
    console.log('终局：' + verdict + '   共 ' + g.moves.length + ' 手' +
        '   引擎累计思考 ' + totalMs + 'ms');
    console.log('─'.repeat(72));
    console.log(renderBoard(g.board));

    // 非法着法 = 必须修的 bug，用非零退出码让它能被 CI 抓到
    process.exitCode = illegal ? 1 : 0;
}

main();
