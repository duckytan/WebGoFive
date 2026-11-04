/**
 * ThreatAI —— TSS 前置求解的 AI 包装层（v2.8.0）
 *
 * 动机：引擎的强制胜短路只有「成五 / 挡五 / VCF（连续冲四）」，
 * 活三级的强制胜（VCT）要靠主搜索慢慢搜 —— 低难度预算下经常漏。
 * v2.7.0 已有 GMK.TSS，这里把它前置到 AI 决策链：
 *
 *   ThreatAI( TunableAI( EngineAI ) )
 *
 * 每手先跑一次有界 TSS：命中 → 直接落子（source='vct'，省掉引擎的
 * 整棵搜索树）；未命中 / 禁手 / 预算不足 / 终局 → 原样委托内层，
 * 决策质量与 v2.7 完全一致。
 *
 * 保守性（宁可不命中，不可走错）：
 *   · TSS 返回 null（含预算耗尽）一律委托 —— 「未证明」不当「必胜」用；
 *   · 黑棋的 VCT 点过一遍 GMK.Forbidden.isForbidden，禁手点委托内层
 *     （TSS 不懂 RIF 禁手，三三双杀点对黑是自杀）；
 *   · BEGINNER 预算为 0：新手难度保留 noise，不该一步不差；
 *   · 委托时 getLastInfo 透传内层，诊断链路（分析面板）不变。
 *
 * 与 TunableAI 的关系： Tunable 管「引擎参数」，Threat 管「搜索前置」，
 * 两者链式叠加；setOverride 透传，App 持有的外层引用行为不变。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    /**
     * 难度 → TSS 预算 {nodeBudget, timeMs}。BEGINNER 关闭（新手保留失误空间）。
     * 双帽取先到者：节点数保证确定性上限，墙钟保证跨机器开销可控 ——
     * TSS 是「搜索之外」的额外开销，不能吃掉引擎自己的思考时间。
     */
    const BUDGETS = {
        BEGINNER: null,
        NORMAL: { nodeBudget: 8000, timeMs: 80 },
        HARD: { nodeBudget: 40000, timeMs: 400 },
        HELL: { nodeBudget: 60000, timeMs: 600 }
    };
    /** TSS 最大攻击深度（攻方手数） */
    const MAX_DEPTH = 6;

    /**
     * 造一个满足 GomokuAI 契约（getMove / getLastInfo / sync）的包装 AI。
     *
     * @param {object} inner 内层 AI（如 TunableAI 包装层），必须实现 getMove/getLastInfo
     * @param {object} opts  { game } —— 核心 GomokuGame 实例（读盘面 / 行棋方 / 终局态）
     * @returns 包装对象：getMove / getLastInfo / sync / setOverride(透传，若内层有)
     */
    function createWrapper(inner, opts) {
        opts = opts || {};
        const game = opts.game || null;
        const budgets = opts.budgets || BUDGETS;
        const C = GMK.C;

        let lastInfo = null;   // TSS 命中时自家诊断；未命中走内层
        // 锁线状态（按行棋方分槽：EvE 下同一包装层服务双方，互不踩踏）。
        // 动机：证明必胜后的「再求解」可能因时间死线掉链子（audit 实证）。
        // 对手按预期防守 → 直接走计划着法（零搜索）；偏离/陈旧 → 解锁重解。
        const locks = { 1: null, 2: null };
        /** 命中后走存杀线：每步 solve（双倍预算，只此一次）→ 记录预期防手 */
        function buildPlan(b, p, budget) {
            const plan = [];
            for (let step = 0; step < MAX_DEPTH + 2; step++) {
                const r = GMK.TSS.solve(b, p, {
                    maxDepth: MAX_DEPTH + 2,
                    nodeBudget: budget.nodeBudget * 2,
                    timeMs: budget.timeMs * 3
                });
                if (!r || !C.inBoard(r.move) || b.cells[r.move] !== C.EMPTY) {
                    return plan.length ? plan : null;
                }
                b.place(r.move, p);
                const entry = { move: r.move, expectedDefender: -1 };
                if (b.isFive(r.move)) { plan.push(entry); return plan; }
                const buf = new Int32Array(8);
                const n = GMK.Kill.fivePoints(b, r.move, p, buf);
                if (n >= 2) { plan.push(entry); return plan; }
                let dIdx;
                if (n === 1) dIdx = buf[0];
                else if (GMK.TSS.bestDefense) dIdx = GMK.TSS.bestDefense(b, p);
                else return plan.length ? plan : null;
                b.place(dIdx, C.opp(p));
                entry.expectedDefender = dIdx;
                plan.push(entry);
            }
            return plan.length ? plan : null;
        }

        const wrapper = {
            getMove(difficulty, moveOpts) {
                const TSS = GMK.TSS;
                const budget = budgets[difficulty] || null;
                const canThreat = !!(TSS && C && game && budget
                    && game.gameStatus !== 'finished'
                    && typeof game.getBoardState === 'function');

                if (canThreat) {
                    const t0 = Date.now();
                    const b = new GMK.Board();
                    b.loadFrom2D(game.getBoardState());
                    const p = game.currentPlayer;
                    const opp = C.opp(p);

                    // ── 锁线跟随：本方计划 + 对手按预期防守 → 直接走计划着法 ──
                    const lock = locks[p];
                    // 子数守卫用「盘面真实子数」而非 history 长度 —— loadFrom2D
                    // 构建的盘 history 虚高（5 子记 10），history 不可作基准
                    const stoneCount2d = game.getBoardState()
                        .reduce((acc, row) => acc + row.filter((v) => v !== 0).length, 0);
                    if (lock && (stoneCount2d !== lock.stonesAtLock + 2 * lock.idx
                        || lock.idx >= lock.plan.length)) {
                        locks[p] = null;   // 子数不符（新对局/悔棋）或计划耗尽 → 解锁
                    }
                    if (locks[p]) {
                        const lk = locks[p];
                        const prev = lk.idx > 0 ? lk.plan[lk.idx - 1] : null;
                        const followed = !prev || (prev.expectedDefender >= 0
                            && b.cells[prev.expectedDefender] === opp);
                        const step = lk.plan[lk.idx];
                        const banned = (p === C.BLACK && GMK.Forbidden
                            && GMK.Forbidden.isForbidden(b, step.move, C.BLACK));
                        if (followed && b.cells[step.move] === C.EMPTY && !banned) {
                            lastInfo = {
                                player: p,
                                difficulty: difficulty,
                                level: difficulty,
                                source: 'vct',
                                move: step.move,
                                score: 500000,
                                depth: lock.plan.length - lock.idx,
                                nodes: 0,
                                vcf: -1,
                                timeMs: Date.now() - t0
                            };
                            lock.idx++;
                            return { x: C.xOf(step.move), y: C.yOf(step.move) };
                        }
                        locks[p] = null;   // 对手偏离 / 着法失效 → 解锁（偏离追击已在 v2.9 评估后移除，见 DELIVERY_PROGRESS）
                    }

                    const r = TSS.solve(b, p, {
                        maxDepth: MAX_DEPTH,
                        nodeBudget: budget.nodeBudget,
                        timeMs: budget.timeMs
                    });
                    if (r && C.inBoard(r.move) && b.cells[r.move] === C.EMPTY) {
                        // 黑棋禁手点不能走（TSS 不懂 RIF）—— 回退内层
                        const banned = (p === C.BLACK && GMK.Forbidden
                            && GMK.Forbidden.isForbidden(b, r.move, C.BLACK));
                        if (!banned) {
                            // 锁线：把整条杀线走存下来（只此一次的双倍预算）
                            const plan = buildPlan(b, p, budget);
                            if (plan) {
                                locks[p] = {
                                    plan: plan,
                                    idx: 1,
                                    player: p,
                                    stonesAtLock: game.getBoardState()
                                        .reduce((acc, row) => acc + row.filter((v) => v !== 0).length, 0)
                                };
                            }
                            lastInfo = {
                                player: p,
                                difficulty: difficulty,
                                level: difficulty,
                                source: 'vct',
                                move: r.move,
                                score: 500000,
                                depth: r.depth,
                                nodes: r.nodes,
                                vcf: -1,
                                timeMs: Date.now() - t0
                            };
                            return { x: C.xOf(r.move), y: C.yOf(r.move) };
                        }
                    }
                }
                lastInfo = null;
                return inner.getMove(difficulty, moveOpts);
            },

            getLastInfo() {
                return lastInfo || (inner.getLastInfo ? inner.getLastInfo() : null);
            },

            sync() {
                if (inner.sync) inner.sync();
            }
        };

        // 测试探针（不参与决策）
        wrapper.__locks = locks;

        // 链式透传：App 持有外层引用即可操作内层的可调参开关
        if (inner && typeof inner.setOverride === 'function') {
            wrapper.setOverride = function (v) { return inner.setOverride(v); };
        }
        return wrapper;
    }

    const ThreatAI = { createWrapper: createWrapper, BUDGETS: BUDGETS, MAX_DEPTH: MAX_DEPTH };

    GMK.ThreatAI = ThreatAI;
    if (typeof module !== 'undefined' && module.exports) module.exports = ThreatAI;
})();
