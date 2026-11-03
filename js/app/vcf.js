/**
 * VCF 连冲练习（重构版）
 *
 * ── 为什么旧版是错的 ────────────────────────────────────────────────
 * 旧版 5 道题全是「棋盘上已有四连，把第五子补上」，对手从不还手。
 * 但 VCF（Victory of Continuous Four，连续冲四取胜）的本质是**强制序列**：
 *   每一手都必须形成「四」—— 对方只有一个合法应点，不得不应；
 *   一串这样的绝对先手串起来，最后必然成五。
 * 没有对手应手，就没有「强制」，玩家学到的只是「补空位」，练不出任何实战能力。
 *
 * ── 本版怎么判定 ────────────────────────────────────────────────────
 * 不存标准答案（VCF 的正确走法往往不唯一，硬编码答案会把对的判成错的），
 * 而是按 VCF 的定义逐步校验：
 *   1. 玩家落子后，若已成五 → 胜。
 *   2. 否则用 Kill.fivePoints 数「补成五的点」：
 *        0 个 → 这手不是冲四，攻击链断裂，**判错并撤销**（棋子不留在盘上）；
 *        1 个 → 标准冲四，对方被迫挡在该点，由本模块自动落白子；
 *        ≥2 个 → 活四 / 双四，对方挡不住，直接判胜。
 *   3. 对方应手后，再用 Kill.vcf 复核「是否还有连冲」：
 *        没有了 → 这条线走死了，判失败并给出提示。
 * 也就是说：**判定标准就是 VCF 本身**，玩家走任意一条成立的连冲线都算对。
 *
 * ── 题库怎么来的 ────────────────────────────────────────────────────
 * 由 tools/gen-vcf.js 用引擎反向生成并验证（随机撒子 → Kill.vcf 必须找到连冲 →
 * 顺着必胜线走一遍得到深度）。tests/engine/vcf.test.js 会逐题复验，
 * 保证「每道题都真的有解、每个首手都真的是冲四」。
 */
(function () {
    'use strict';
    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    const SIZE = 15;
    const STORE_KEY = 'gmk_vcf_v2';
    const CUSTOM_KEY = 'gmk_vcf_custom_v1';   // 自定义题独立存档：「清空进度」不应误删用户摆的题
    const VCT_OPTS = { maxDepth: 8, nodeBudget: 200000 };   // VCT 判定的求解预算
    let _mem = null;      // 无 localStorage 时的内存存档
    let _memCustom = null;

    /** 扁平字符串（225 字符，'0' 空 / '1' 黑 / '2' 白）→ 15×15 二维数组 */
    function parseBoard(flat) {
        const g = [];
        for (let y = 0; y < SIZE; y++) {
            const row = [];
            for (let x = 0; x < SIZE; x++) row.push(+flat[y * SIZE + x] || 0);
            g.push(row);
        }
        return g;
    }

    function name(p) { return String.fromCharCode(65 + p.x) + (p.y + 1); }

    /* ---------------- 题库 ---------------- */
    // level: 1 入门 / 2 进阶 / 3 高阶；depth: 最少连续冲四手数
    const RAW = [
        {
            id: 'vcf-01', level: 1, depth: 1, title: '一手双四',
            lesson: '落一手同时形成两个四，对方只能挡一个 —— 这就是 VCF 的终点形态。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000002000120000000000010000000000000101000000000000100100000000020000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vcf-02', level: 1, depth: 2, title: '连冲两手',
            lesson: '第一手冲四逼对方挡，第二手借新落之子形成活四。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000000000000000120020000000001100120000000000001000000000020000001000000020000000000000020000000000000000000100000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vcf-03', level: 1, depth: 2, title: '竖线接力',
            lesson: '纵向四连被堵住一头时，先横后竖，换条线继续逼。',
            board: '000000000000000000000000000000000000000000000000000000000000000000200000000000000002100200000000000100000000000002002000000000000021000000000000001000000000000001000000000201010000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vcf-04', level: 1, depth: 2, title: '边线收割',
            lesson: '贴着边线也能连冲 —— 边线不是障碍，反而少一处被挡的方向。',
            board: '000000000000000000000000000000000000000000000000000000000000000010000210000000000100101100000000000000000000000002000000000000000000000000000020002000000010200000000000000000000200000000000001000000000000000000000000000000000'
        },
        {
            id: 'vcf-05', level: 2, depth: 3, title: '三连冲',
            lesson: '每一手都要是四。中间任何一手做成「三」，对方就不必应，链子立刻断。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000002000000000002000000000000000000000000000101010000000001000000000000001020000100000000100000000000000000020000000002002000000000000000000000000000000000000'
        },
        {
            id: 'vcf-06', level: 2, depth: 3, title: '斜线转折',
            lesson: '冲四不必都在同一条线上，靠落子把横、竖、斜串起来才是连冲。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000000000000000202002000000000010000000000000000100100000020002101000000000000000000000000010000200000000000000000000001000000000000000000000000000000000000000'
        },
        {
            id: 'vcf-07', level: 2, depth: 3, title: '多线并进',
            lesson: '盘面越复杂，越要算清「对方唯一应点」在哪里，别被别的子干扰。',
            board: '000000000000000000000000000000000000000000000000000000000000000002000100000000000200000000000010020000000000001000220000000000001100100000001000000000000000000020000000002000000000000000010020000000000000000000000000000000000'
        },
        {
            id: 'vcf-08', level: 3, depth: 4, title: '四步连冲',
            lesson: '四手连续绝对先手。中途没有一步可以缓，缓一手就前功尽弃。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000020000000000000011001000000000001020000000000000000000100000000102000000000000001022000000000000000000000000000000000'
        },
        {
            id: 'vcf-09', level: 3, depth: 4, title: '长链算杀',
            lesson: '子力最多的局面。把「每一手都是四」当作唯一标准去试，不要凭感觉。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000101200100000000200020000000000000100000000000000010000000000200020000000000000102000000020001010100000000000000000000000000000000'
        }
    ];

    /* VCT 题库（type: 'vct'）：威胁不限于四，活三也算 —— 求解器是 js/engine/tss.js，
     * 生成走 tools/gen-vct.js（VCF 必须解不出 + TSS 解出 + 首着是活三 + 走线验证），
     * 判定与会话共用同一求解器口径，不存标准答案。 */
    const VCT_RAW = [
        {
            id: 'vct-01', level: 2, depth: 3, title: '三线接力',
            lesson: '两条线轮着施压，对方堵得了一头堵不了两头。',
            board: '000000000000000000000000000000000000000000000000000000010000000000000100000000000100000000000000000000000000000001000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vct-02', level: 2, depth: 3, title: '双线轮转',
            lesson: '活三不强制但要跟上 —— 把每手威胁串成链。',
            board: '000000000000000000000000000000000000001000000000000010000000000001000000000002000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vct-03', level: 2, depth: 3, title: '断点回春',
            lesson: '补断成三也是威胁，别只盯着四。',
            board: '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100100000000000000200000000000102100000000000000010000000000000000000000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vct-04', level: 2, depth: 3, title: '先三后四',
            lesson: '活三逼应，转四的时机是全部。',
            board: '000000000000000000000000000000000000000100000000020001000000000000000000000000010010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vct-05', level: 3, depth: 4, title: '深算长链',
            lesson: '四手连续威胁，中途缓一手就前功尽弃。',
            board: '000000000000000000000000000000000000000000000000002000000000000000100000000000000001000000000000000000000000000101000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        },
        {
            id: 'vct-06', level: 2, depth: 3, title: '闷声做杀',
            lesson: '看似平静的三，藏着两条杀路。',
            board: '000000000000000000000000000000000000000000100000000000001000000000210000000000000000000000000000000010000000000020001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
        }
    ];

    const PUZZLES = RAW.map(function (p) {
        return {
            id: p.id,
            level: p.level,
            levelName: ['', '入门', '进阶', '高阶'][p.level],
            depth: p.depth,
            title: p.title,
            lesson: p.lesson,
            board: parseBoard(p.board),
            sideToMove: 1,
            type: 'vcf'
        };
    }).concat(VCT_RAW.map(function (p) {
        return {
            id: p.id,
            level: p.level,
            levelName: ['', '入门', '进阶', '高阶'][p.level],
            depth: p.depth,
            title: p.title,
            lesson: p.lesson,
            board: parseBoard(p.board),
            sideToMove: 1,
            type: 'vct'
        };
    })).concat(loadCustoms());

    /** 读自定义题存档（Node 无 localStorage 时走 _memCustom） */
    function loadCustoms() {
        let raw = null;
        if (typeof localStorage === 'undefined' || !localStorage) {
            raw = _memCustom;
        } else {
            try { raw = localStorage.getItem(CUSTOM_KEY); } catch (e) { raw = null; }
        }
        if (!raw) return [];
        try {
            const list = JSON.parse(raw);
            if (!Array.isArray(list)) return [];
            return list.map(function (p) {
                return {
                    id: p.id, level: p.level, levelName: ['', '入门', '进阶', '高阶'][p.level] || '入门',
                    depth: p.depth, title: p.title, lesson: p.lesson || '自定义题目',
                    board: parseBoard(p.board), sideToMove: 1, custom: true
                };
            }).filter(function (p) { return p.board; });
        } catch (e) { return []; }
    }

    function saveCustoms(list) {
        const s = JSON.stringify(list);
        _memCustom = s;
        if (typeof localStorage === 'undefined' || !localStorage) return;
        try { localStorage.setItem(CUSTOM_KEY, s); } catch (e) {}
    }

    /* ---------------- 会话（状态机） ---------------- */

    function cloneEngine(src) {
        const C = GMK.C, b = new GMK.Board();
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const v = src.cells[C.idx(x, y)];
                if (v) b.place(C.idx(x, y), v);
            }
        }
        return b;
    }

    /** i 点假设落 p 子是否形成活三（VCT 的威胁判定） */
    function isOpenThreeAt(engine, i, p) {
        const shapes = new Int8Array(4);
        GMK.Evaluator.pointShapes(engine, i, p, shapes);
        for (let d = 0; d < 4; d++) if (shapes[d] === GMK.C.SHAPE.OPEN_THREE) return true;
        return false;
    }

    class VcfSession {
        constructor(puzzle) {
            this.puzzle = puzzle;
            this.type = puzzle.type || 'vcf';
            this.engine = new GMK.Board();
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    if (puzzle.board[y][x]) this.engine.place(GMK.C.idx(x, y), puzzle.board[y][x]);
                }
            }
            this.state = 'playing';       // playing | solved | failed
            this.steps = 0;               // 玩家已完成的冲四手数
            this.history = [];            // [{ black:{x,y}, white:{x,y}|null }]
            this.lastReply = null;
            this.reason = '';
            this.startedAt = 0;
        }

        get board2d() {
            const g = [];
            for (let y = 0; y < SIZE; y++) {
                const row = [];
                for (let x = 0; x < SIZE; x++) row.push(this.engine.cells[GMK.C.idx(x, y)]);
                g.push(row);
            }
            return g;
        }

        get lastMove() {
            const h = this.history[this.history.length - 1];
            if (!h) return null;
            return h.white || h.black;
        }

        /**
         * 玩家落子。返回 { code, reply?, points?, dead? }
         *   WIN     成五
         *   DOUBLE  活四/双四，对方挡不住 → 胜
         *   FOUR    冲四成立，对方已自动应手
         *   THREE   活三施压（仅 VCT 题），对方已自动应手
         *   NOT_FOUR 不是威胁（VCF:非四 / VCT:非四非活三），攻击链断裂（棋子已撤回）
         *   OCCUPIED / FINISHED
         */
        play(x, y) {
            if (this.state !== 'playing') return { code: 'FINISHED' };
            const C = GMK.C, Kill = GMK.Kill;
            const i = C.idx(x, y);
            if (this.engine.cells[i] !== C.EMPTY) return { code: 'OCCUPIED' };

            this.engine.place(i, C.BLACK);

            if (this.engine.isFive(i)) {
                this.steps++;
                this.history.push({ black: { x, y }, white: null });
                this.state = 'solved';
                this.reason = 'five';
                return { code: 'WIN' };
            }

            const buf = new Int32Array(8);
            const n = Kill.fivePoints(this.engine, i, C.BLACK, buf);

            if (n === 0) {
                // 不是冲四：撤掉，棋子不留在盘上，避免污染后续判断
                this.engine.unplace();
                // VCT：活三也是合法威胁
                if (this.type === 'vct' && isOpenThreeAt(this.engine, i, C.BLACK)) {
                    this.engine.place(i, C.BLACK);
                    this.steps++;
                    const dIdx = GMK.TSS.bestDefense(this.engine, C.BLACK);
                    this.engine.place(dIdx, C.WHITE);
                    const reply = { x: C.xOf(dIdx), y: C.yOf(dIdx) };
                    this.lastReply = reply;
                    this.history.push({ black: { x, y }, white: reply });
                    if (!this.chainAlive()) {
                        this.state = 'failed';
                        this.reason = 'dead';
                        return { code: 'THREE', reply: reply, dead: true };
                    }
                    return { code: 'THREE', reply: reply, dead: false };
                }
                return { code: 'NOT_FOUR' };
            }

            this.steps++;

            if (n >= 2) {
                // 活四 / 双四：对方只能挡一处，下一手必成五
                this.history.push({ black: { x, y }, white: null });
                this.state = 'solved';
                this.reason = 'double';
                return { code: 'DOUBLE', points: n };
            }

            const block = buf[0];
            this.engine.place(block, C.WHITE);
            const reply = { x: C.xOf(block), y: C.yOf(block) };
            this.lastReply = reply;
            this.history.push({ black: { x, y }, white: reply });

            // 对方应手之后，黑方还有没有连杀？没有说明这条线走死了
            if (!this.chainAlive()) {
                this.state = 'failed';
                this.reason = 'dead';
                return { code: 'FOUR', reply: reply, dead: true };
            }
            return { code: 'FOUR', reply: reply, dead: false };
        }

        /** 链条是否还活着：VCF 用 Kill.vcf，VCT 用 TSS.solve（口径与生成一致） */
        chainAlive() {
            if (this.type === 'vct') {
                return GMK.TSS ? GMK.TSS.solve(this.engine, GMK.C.BLACK, VCT_OPTS) !== null : false;
            }
            return GMK.Kill.vcf(this.engine, GMK.C.BLACK, 12) >= 0;
        }

        /** 撤销一个完整回合（我方冲四 + 对方被迫应手） */
        undo() {
            const h = this.history.pop();
            if (!h) return false;
            if (h.white) this.engine.unplace();   // 先撤白（后落的先撤）
            this.engine.unplace();                // 再撤黑
            this.steps = Math.max(0, this.steps - 1);
            const prev = this.history[this.history.length - 1];
            this.lastReply = prev ? prev.white : null;
            this.state = 'playing';
            this.reason = '';
            return true;
        }

        /** 提示：引擎算出的下一手必胜着法（VCF 首选冲四 / VCT 走 TSS） */
        hint() {
            if (this.type === 'vct' && GMK.TSS) {
                const r = GMK.TSS.solve(this.engine, GMK.C.BLACK, VCT_OPTS);
                if (!r) return null;
                return { x: GMK.C.xOf(r.move), y: GMK.C.yOf(r.move) };
            }
            const m = GMK.Kill.vcf(this.engine, GMK.C.BLACK, 12);
            if (m < 0) return null;
            return { x: GMK.C.xOf(m), y: GMK.C.yOf(m) };
        }

        /** 参考线：从当前局面顺出的完整连杀序列（含对方应手） */
        solution() {
            const C = GMK.C, Kill = GMK.Kill;
            const b = cloneEngine(this.engine);
            const line = [];
            const buf = new Int32Array(8);
            for (let d = 0; d < 20; d++) {
                let m;
                if (this.type === 'vct' && GMK.TSS) {
                    const r = GMK.TSS.solve(b, C.BLACK, VCT_OPTS);
                    if (!r) break;
                    m = r.move;
                } else {
                    m = Kill.vcf(b, C.BLACK, 14);
                    if (m < 0) break;
                }
                const mv = { x: C.xOf(m), y: C.yOf(m) };
                b.place(m, C.BLACK);
                if (b.isFive(m)) { line.push({ black: mv, white: null }); break; }
                const n = Kill.fivePoints(b, m, C.BLACK, buf);
                if (n >= 2) { line.push({ black: mv, white: null }); break; }
                let wIdx;
                if (n === 1) {
                    wIdx = buf[0];                          // 冲四:对方被迫挡
                } else if (this.type === 'vct' && GMK.TSS) {
                    wIdx = GMK.TSS.bestDefense(b, C.BLACK); // 活三:防手自由,取最强应手
                } else {
                    break;                                  // VCF:无四即断链
                }
                const r = { x: C.xOf(wIdx), y: C.yOf(wIdx) };
                b.place(wIdx, C.WHITE);
                line.push({ black: mv, white: r });
            }
            return line;
        }

        get elapsed() {
            return this.startedAt ? Date.now() - this.startedAt : 0;
        }
    }

    /* ---------------- 进度存档 ---------------- */

    const VCFPractice = {
        PUZZLES: PUZZLES,
        Session: VcfSession,
        LEVELS: [
            { id: 1, name: '入门' },
            { id: 2, name: '进阶' },
            { id: 3, name: '高阶' }
        ],

        create(idx) {
            const p = PUZZLES[idx] || PUZZLES[0];
            return new VcfSession(p);
        },

        indexOf(id) {
            for (let i = 0; i < PUZZLES.length; i++) if (PUZZLES[i].id === id) return i;
            return -1;
        },

        /* --- 成绩 --- */
        // Node 里没有 localStorage，用内存兜底，保证同一套逻辑可被单测覆盖
        _load() {
            if (typeof localStorage === 'undefined' || !localStorage) {
                return _mem ? JSON.parse(_mem) : {};
            }
            try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
        },
        _save(o) {
            const s = JSON.stringify(o);
            _mem = s;
            if (typeof localStorage === 'undefined' || !localStorage) return;
            try { localStorage.setItem(STORE_KEY, s); } catch (e) {}
        },
        /** 记录一次通关：只在更快/更少手时更新 */
        record(id, ms, steps) {
            const all = this._load();
            const cur = all[id] || {};
            const better = !cur.ms || ms < cur.ms;
            all[id] = {
                ms: better ? ms : cur.ms,
                steps: better ? steps : cur.steps,
                solvedAt: cur.solvedAt || Date.now(),
                times: (cur.times || 0) + 1
            };
            this._save(all);
            return all[id];
        },
        getBest() {
            const all = this._load(), out = {};
            // ms 可能是 0（极快通关），不能用真值判断
            for (const k in all) if (all[k] && all[k].ms != null) out[k] = all[k].ms;
            return out;
        },
        getRecord(id) { return this._load()[id] || null; },
        solvedCount() {
            const all = this._load();
            let n = 0;
            for (const k in all) if (all[k] && all[k].ms) n++;
            return n;
        },
        clearProgress() { this._save({}); },

        /* --- 每日一题 ---
         * 按日期从题库做确定性选题（同一天永远同一题，跨天自动换），
         * 通关累积连胜（断一天清零）。连胜状态与成绩共用一个存档键。 */
        /** 本地时区 YYYY-MM-DD（不能用 toISOString——那是 UTC，晚上八点后日期会漂） */
        dateKey(d) {
            const y = d.getFullYear();
            const m = d.getMonth() + 1;
            const day = d.getDate();
            return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
        },
        /** 日期键 → 题目索引：多项式滚动哈希，同日恒定、不同日尽量分散 */
        dailyIndex(key) {
            let h = 0;
            for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
            return h % PUZZLES.length;
        },
        /** 今日每日一题状态：{ dateKey, index, puzzle, solved, streak } */
        daily(key) {
            key = key || this.dateKey(new Date());
            const all = this._load();
            const d = all.daily || {};
            return {
                dateKey: key,
                index: this.dailyIndex(key),
                puzzle: PUZZLES[this.dailyIndex(key)],
                solved: d.lastKey === key,
                streak: d.streak || 0
            };
        },
        /** 通关「key 那天」的每日一题时调用：首解累积连胜，同日重复不叠加。
         *  连续判定按「key 的前一天」算，而不是按真实今天 —— 语义自洽，也才可测。 */
        recordDaily(key) {
            key = key || this.dateKey(new Date());
            const parts = key.split('-');
            const prev = new Date(+parts[0], +parts[1] - 1, +parts[2]);
            prev.setDate(prev.getDate() - 1);
            const yKey = this.dateKey(prev);
            const all = this._load();
            const d = all.daily || {};
            if (d.lastKey === key) return d.streak || 1;
            d.streak = (d.lastKey === yKey) ? (d.streak || 0) + 1 : 1;
            d.lastKey = key;
            all.daily = d;
            this._save(all);
            return d.streak;
        },

        /* --- 错题本 ---
         * 记录玩家走错的题（不是冲四 / 走死 / 看答案），最新在前，上限 50 条。
         * 条目只存 { puzzle, move, reason, at }，重练时按 puzzle 反查题库。 */
        wrongbookAdd(puzzleId, move, reason) {
            const all = this._load();
            const list = Array.isArray(all.wrongbook) ? all.wrongbook : [];
            list.unshift({ puzzle: puzzleId, move: move || null, reason: reason || '', at: Date.now() });
            if (list.length > 50) list.length = 50;
            all.wrongbook = list;
            this._save(all);
            return list.length;
        },
        wrongbookList() {
            const all = this._load();
            return Array.isArray(all.wrongbook) ? all.wrongbook.slice() : [];
        },
        wrongbookCount() { return this.wrongbookList().length; },
        wrongbookClear() {
            const all = this._load();
            all.wrongbook = [];
            this._save(all);
        },

        /* --- 限时挑战 ---
         * 等级 → 秒数。考验模式识别速度（VCF-REDESIGN §7）。
         * App 层按 p.level 查表起倒计时，超时判负并记入错题本。 */
        TIME_LIMIT: { 1: 45, 2: 75, 3: 120 },

        /* --- 自定义题库（PRD Q3）---
         * 摆题 → 引擎校验「黑方真有连冲解」→ 入库。判定与内置题同一套状态机，
         * 不存标准答案，只存初始盘面。 */
        /** 15×15 二维盘面 → 扁平字符串（存档格式与内置题一致） */
        flattenBoard(board2d) {
            let s = '';
            for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) s += (board2d[y][x] || 0);
            return s;
        },
        /**
         * 校验并保存自定义题。
         * @returns {{ok:true, puzzle, index}|{ok:false, error:string}}
         */
        addCustom(board2d) {
            const C = GMK.C, Kill = GMK.Kill;
            if (!Array.isArray(board2d) || board2d.length !== SIZE ||
                board2d.some((r) => !Array.isArray(r) || r.length !== SIZE)) {
                return { ok: false, error: '棋盘数据无效' };
            }
            let blacks = 0, whites = 0;
            const b = new GMK.Board();
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const v = board2d[y][x];
                    if (v !== 1 && v !== 2) continue;
                    const i = C.idx(x, y);
                    if (b.cells[i] !== C.EMPTY) return { ok: false, error: '棋盘数据重复' };
                    b.place(i, v);
                    if (v === 1) blacks++; else whites++;
                }
            }
            if (blacks === 0) return { ok: false, error: '至少要摆一颗黑子（黑方先行）' };
            if (blacks < whites) return { ok: false, error: '黑方先行：黑子数不能少于白子数' };

            // 盘面上不能已有五连（否则不是「解题」而是「看答案」）
            for (let i = 0; i < C.CELLS; i++) {
                if (b.cells[i] !== C.EMPTY && b.isFive(i)) {
                    return { ok: false, error: '盘面上已经有五连，请先拿掉' };
                }
            }
            // 黑方必须真有连冲解 —— 与内置题同一判定
            if (Kill.vcf(b, C.BLACK, 12) < 0) {
                return { ok: false, error: '这个局面黑方没有连冲解，加/挪几颗黑子试试' };
            }
            // 实际解的深度（强制线的黑方手数），难度按深度分档 —— 与内置题同规则
            const s = new VcfSession({ board: board2d, depth: 0, level: 1, title: '', lesson: '', sideToMove: 1 });
            const line = s.solution();
            const depth = line.length;
            if (depth < 1) return { ok: false, error: '无法导出连冲解，请调整盘面' };
            const level = depth >= 4 ? 3 : (depth >= 3 ? 2 : 1);

            const puzzle = {
                id: 'custom-' + Date.now().toString(36),
                level: level,
                levelName: ['', '入门', '进阶', '高阶'][level],
                depth: depth,
                title: '自定义 · ' + depth + ' 手',
                lesson: '自定义题目：黑方连冲取胜。',
                board: board2d.map((r) => r.slice()),
                sideToMove: 1,
                custom: true
            };
            const customs = loadCustoms();
            customs.push({ id: puzzle.id, level: puzzle.level, depth: puzzle.depth, title: puzzle.title, board: this.flattenBoard(board2d) });
            saveCustoms(customs);
            PUZZLES.push(puzzle);
            return { ok: true, puzzle: puzzle, index: PUZZLES.length - 1 };
        },
        /** 删除自定义题（内置题不可删） */
        removeCustom(id) {
            const idx = PUZZLES.findIndex(function (p) { return p.id === id && p.custom; });
            if (idx < 0) return false;
            PUZZLES.splice(idx, 1);
            saveCustoms(loadCustoms().filter(function (p) { return p.id !== id; }));
            // 成绩/错题里的残留条目引用已删的题，一并清掉
            const all = this._load();
            delete all[id];
            if (Array.isArray(all.wrongbook)) all.wrongbook = all.wrongbook.filter(function (w) { return w.puzzle !== id; });
            this._save(all);
            return true;
        },
        customCount() { return loadCustoms().length; },

        /* --- 兼容旧接口（E2E/旧脚本仍引用） --- */
        current: null,
        start(idx) { this.current = PUZZLES[idx] || PUZZLES[0]; return this.current; },
        loadBoard(game) {
            if (!this.current) return false;
            const b = this.current.board.map(r => r.slice());
            return game.loadCustomState({ board: b, currentPlayer: 1, gameStatus: 'playing' });
        },
        checkSolved(board2d) {
            const C = GMK.C, eng = new GMK.Board();
            eng.loadFrom2D(board2d);
            for (let i = 0; i < C.CELLS; i++) if (eng.isFive(i) && eng.cells[i] === C.BLACK) return true;
            return false;
        },
        /** 某题的参考线（E2E / 文档用） */
        solutionOf(idx) {
            const s = new VcfSession(PUZZLES[idx] || PUZZLES[0]);
            return s.solution();
        },
        name: name
    };

    GMK.VCFPractice = VCFPractice;
    GMK.VCF = VCFPractice;   // 简短别名
    if (typeof module !== 'undefined' && module.exports) module.exports = VCFPractice;
})();
