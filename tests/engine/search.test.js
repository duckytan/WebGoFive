/**
 * 搜索内核的不变量测试
 *
 * 运行：node tests/search.test.js
 *
 * 这里测的不是「棋下得好不好」（那是 selfplay 的事），而是
 * **搜索跑完之后棋盘必须原封不动**。这一条看着琐碎，但它曾经
 * 是最致命的 bug：超时靠抛异常跳出递归，栈上每层的 place()
 * 都没撤销，于是棋盘上残留幽灵棋子，之后每一步都在错局面上搜索。
 * 症状是「引擎突然开始走毫不相关的点」，看起来像棋力问题，
 * 实际是状态污染 —— 没有这条断言就极难定位。
 */

'use strict';

const path = require('path');
const ENGINE = path.join(__dirname, '..', '..', 'js', 'engine');

require(path.join(ENGINE, 'constants.js'));
const Board = require(path.join(ENGINE, 'board.js'));
require(path.join(ENGINE, 'evaluator.js'));
const Search = require(path.join(ENGINE, 'search.js'));
require(path.join(ENGINE, 'kill.js'));
const Forbidden = require(path.join(ENGINE, 'forbidden.js'));

const C = globalThis.GMK.C;
const { BLACK, WHITE, EMPTY } = C;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (extra ? '  →  ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
}
function eq(a, b, name) {
    ok(a === b, name, `期望 ${b}，实际 ${a}`);
}
function section(t) { console.log('\n' + t); }

const nm = i => String.fromCharCode(65 + C.xOf(i)) + (C.yOf(i) + 1);

/** 局面指纹：棋子 + 棋型计数 + 点视角编码 + 哈希 */
function fingerprint(b) {
    return [
        Array.from(b.cells).join(','),
        Array.from(b.shapeCount).join(','),
        Array.from(b.codeB).join(','),
        Array.from(b.codeW).join(','),
        b.neighbor.join(','),
        b.history.join(','),
        b.zlo, b.zhi
    ].join('|');
}

function makeBoard(stones) {
    const b = new Board();
    for (const s of stones) b.place(C.idx(s[0], s[1]), s[2] || BLACK);
    return b;
}

/** 一个典型中局 */
const MIDGAME = [
    [7, 7, 1], [6, 6, 2], [7, 5, 1], [7, 6, 2],
    [8, 6, 1], [6, 8, 2], [6, 4, 1], [9, 7, 2],
    [5, 3, 1], [4, 2, 2], [9, 5, 1], [10, 4, 2],
    [8, 5, 1], [6, 5, 2], [6, 7, 1], [11, 5, 2]
];

/* ================================================================== *
 * 1. 超时不能污染棋盘
 * ================================================================== */

section('[1] 超时回滚');

{
    const b = makeBoard(MIDGAME);
    const before = fingerprint(b);

    // 时间预算小到几乎必然在递归中途超时
    for (const ms of [0, 1, 2, 5, 10, 20]) {
        const s = new Search({ ttBits: 12 });
        s.think(b, { timeMs: ms, depth: 12, candidates: 16, side: b.sideToMove() });
        const diff = fingerprint(b) === before;
        ok(diff, `timeMs=${ms} 后棋盘必须完全复原`,
            diff ? '' : `棋子数 ${b.stoneCount()}（原 ${MIDGAME.length}）`);
    }
}

{
    // 反复搜索同一局面：每一次都必须复原，累积也不能漂移
    const b = makeBoard(MIDGAME);
    const before = fingerprint(b);
    const s = new Search({ ttBits: 12 });
    for (let k = 0; k < 8; k++) {
        s.think(b, { timeMs: 15, depth: 10, candidates: 16, side: b.sideToMove() });
    }
    ok(fingerprint(b) === before, '连续 8 次超时搜索后棋盘仍完全复原');
    eq(b.stoneCount(), MIDGAME.length, '连续搜索后棋子数不变');
}

/* ================================================================== *
 * 2. 返回的着法必须合法
 * ================================================================== */

section('[2] 着法合法性');

{
    const b = makeBoard(MIDGAME);
    const p = b.sideToMove();
    const s = new Search({ ttBits: 12 });
    const res = s.think(b, { timeMs: 200, depth: 6, candidates: 16, side: p });
    ok(res.move >= 0, '应返回一个着法');
    ok(C.inBoard(res.move), '着法必须在棋盘内');
    eq(b.cells[res.move], EMPTY, '着法必须落在空点');
    ok(res.depth >= 1, '至少完成 1 层搜索');
}

{
    // 空盘 → 天元
    const b = new Board();
    const s = new Search({ ttBits: 12 });
    const res = s.think(b, { timeMs: 100, depth: 4, side: BLACK });
    eq(res.move, C.idx(7, 7), '空盘应直接下天元');
}

/* ================================================================== *
 * 3. 必胜着法必须找到
 * ================================================================== */

section('[3] 战术正确性');

{
    // 黑有四连（活四），必须直接成五
    const b = makeBoard([[3, 7], [4, 7], [5, 7], [6, 7], [0, 0, WHITE], [1, 0, WHITE]]);
    const s = new Search({ ttBits: 12 });
    const res = s.think(b, { timeMs: 200, depth: 4, side: BLACK });
    b.place(res.move, BLACK);
    const five = b.isFive(res.move);
    b.unplace();
    ok(five, '活四局面必须直接成五', '实际走 ' + nm(res.move));
}

{
    // 白有活三，黑必须挡两端之一
    const b = makeBoard([
        [0, 0], [1, 0], [4, 7, WHITE], [5, 7, WHITE], [6, 7, WHITE]
    ]);
    const s = new Search({ ttBits: 12 });
    const res = s.think(b, { timeMs: 300, depth: 4, side: BLACK });
    ok(res.move === C.idx(3, 7) || res.move === C.idx(7, 7),
        '对手活三必须挡两端', '实际走 ' + nm(res.move));
}

/* ================================================================== *
 * 4. 禁手屏蔽表生效
 * ================================================================== */

section('[4] 禁手屏蔽');

{
    // 黑下 (5,7) 会形成四四（行 2,3,4 + 列 5,8,9,10）
    const b = makeBoard([
        [2, 7], [3, 7], [4, 7],
        [5, 8], [5, 9], [5, 10],
        [0, 0, WHITE]
    ]);
    const ban = new Int8Array(C.CELLS);
    ban[C.idx(5, 7)] = 1;

    const s = new Search({ ttBits: 12 });
    s.banBlack = ban;
    const res = s.think(b, { timeMs: 200, depth: 4, side: BLACK });
    ok(res.move !== C.idx(5, 7), '被禁的点不应被选中', '实际走 ' + nm(res.move));
}

/* ================================================================== *
 * 5. 迭代加深：时间越多，深度不减
 * ================================================================== */

section('[5] 迭代加深');

{
    const b = makeBoard(MIDGAME);
    const s = new Search({ ttBits: 14 });
    const r1 = s.think(b, { timeMs: 50, depth: 10, candidates: 16, side: b.sideToMove() });
    const r2 = s.think(b, { timeMs: 400, depth: 10, candidates: 16, side: b.sideToMove() });
    ok(r2.depth >= r1.depth, '时间更充裕时搜索深度不应下降',
        `50ms→d${r1.depth}，400ms→d${r2.depth}`);
    ok(r2.nodes >= r1.nodes, '时间更充裕时节点数不应下降');
}

/* ------------------------------------------------------------------ *
 * 6. 置换表的符号一致性
 *
 * this.lo / this.hi 是 Uint32Array（无符号），而 board.zlo / zhi 是
 * `(x ^ y) | 0` 出来的有符号 32 位整数。如果直接拿有符号值去比，
 * 只要哈希是负数，同一个局面就会被判成两个不同局面：
 *
 *     存进去 -777305067，读回 3517662229，比较时恒不相等
 *
 * 后果是约 3/4 的局面永远命中不了（zlo、zhi 都得为正才行），
 * 命中率从 ~22% 掉到 ~3.5%，而且**不报任何错**。
 * 这组用例把「正负四种组合都必须命中」钉死。
 * ------------------------------------------------------------------ */

section('[6] 置换表符号一致性');

{
    const TT = globalThis.GMK.TranspositionTable;
    const FLAG_EXACT = 1;

    const cases = [
        { lo: -777305067, hi: -1675712351, name: 'lo、hi 均为负' },
        { lo: 261293259, hi: -1908393330, name: 'lo 正、hi 负' },
        { lo: -246735130, hi: 420368989, name: 'lo 负、hi 正' },
        { lo: 1066469669, hi: 335553577, name: 'lo、hi 均为正' }
    ];

    for (const c of cases) {
        const tt = new TT(12);
        tt.newSearch();
        tt.store(c.lo, c.hi, 5, 1234, FLAG_EXACT, 42, 0);

        const e = tt.probe(c.lo, c.hi, 5, 0);
        ok(e !== null, c.name + '：probe 应命中');
        ok(e && e.move === 42, c.name + '：着法应正确', e ? String(e.move) : 'null');
        ok(e && e.score === 1234, c.name + '：分值应正确', e ? String(e.score) : 'null');
        ok(tt.getMove(c.lo, c.hi) === 42, c.name + '：getMove 应返回着法',
            String(tt.getMove(c.lo, c.hi)));
    }

    // 批量往返：随机 500 个键（含大量负数），存进去再查，必须全中
    const tt = new TT(16);
    tt.newSearch();
    const keys = [];
    let seed = 0x5DEECE66 | 0;
    const rnd = () => {
        seed ^= seed << 13; seed |= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed |= 0;
        return seed | 0;                       // 保持有符号
    };
    for (let k = 0; k < 500; k++) {
        const lo = rnd(), hi = rnd();
        keys.push([lo, hi]);
        tt.store(lo, hi, 3, k, FLAG_EXACT, k % 600, 0);
    }
    let hit = 0;
    for (let k = 0; k < keys.length; k++) {
        if (tt.getMove(keys[k][0], keys[k][1]) === k % 600) hit++;
    }
    ok(hit === keys.length, '500 个含负数的键应全部往返成功',
        hit + '/' + keys.length + ' 命中');

    // 负数键的占比应当接近一半；若为 0 说明这个用例其实没测到问题
    const negCount = keys.filter(([lo, hi]) => lo < 0 || hi < 0).length;
    ok(negCount > 300, '样本里应有大量负哈希（否则测不到符号 bug）',
        negCount + '/' + keys.length);
}

/* ================================================================== */

console.log('\n' + '─'.repeat(52));
if (fail === 0) {
    console.log(`✓ 全部通过：${pass} 项`);
    process.exit(0);
} else {
    console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项`);
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
}
