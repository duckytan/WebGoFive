/**
 * 五子棋引擎 —— 威胁空间搜索（VCT）
 *
 * VCT = Victory of Continuous Threats：连续威胁取胜，威胁不再限于「四」，
 * 还包括「活三」—— 活三不强制（对手不必应），所以搜索空间大一个量级，
 * 这正是 kill.js 注释里「不做完整实现」的部分。
 *
 * ── 本模块的受限口径（练习模式语义，必须与判定端共享）────────────────
 *   1. 攻方每一手必须立刻形成威胁：≥1 个成五点（冲四/活四）或 ≥1 个活三。
 *      眠三不构成威胁，不算。
 *   2. 成五点恰 1 → 对手被迫挡（强制，同 VCF）；
 *      成五点 ≥2 → 活四/双四，直接胜；
 *      无四但有活三 → 对手获得一手自由，进入 AND 节点。
 *   3. AND 节点的防守方应手集 = 「与任意棋子相邻的空点」（neighbor > 0）。
 *      完备性论证：能反驳攻方威胁的应手——挡三的挡点、反冲四的成四点——
 *      都必然与同色既有棋子相邻（成四/成五的点一定落在含已有子的 5 格窗内）；
 *      集合外的闲着不改变攻方下一手的强制性质。集合内**逐一验证**攻方仍胜，
 *      才算攻方获胜 —— 宁可漏判（保守），不可误判。
 *   4. 防守反制：防手若使自己获得成五点（反冲四），攻方链条被打断，
 *      该防手直接判攻方失败（与 kill.vcf 的 underThreat 规则同源）。
 *      攻方想穿透反冲四，必须在同一手里「既进攻又挡」—— 那会表现为
 *      候选里另一个同时挡防五点的威胁着法，由枚举自然覆盖。
 *   5. 深度上限 + 节点预算双保险：任一耗尽立即放弃整棵树，返回
 *      「不知道」而不是「赢」—— 预算内没找到 ≠ 不存在，所以 solve
 *      返回 null 只能理解为「未证明」，不能理解为「必不胜」。
 *
 * 与既有模块的关系：复用 Kill.fourMoves / Kill.fivePoints / Kill.underThreat
 * 与 Evaluator.pointShapes（空点 = 假设落子语义），不改动任何既有文件。
 *
 * @module engine/tss
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    if (typeof module !== 'undefined' && module.exports && !root.GMK) {
        require('./constants.js');
        require('./board.js');
        require('./evaluator.js');
        require('./kill.js');
    }
    const C = root.GMK.C;
    const Ev = root.GMK.Evaluator;
    const Kill = root.GMK.Kill;
    const { EMPTY, SHAPE, SIZE, PAD, W } = C;

    /** 防守应手的近域半径（切比雪夫距离，见模块注释第 3 条） */
    const DEFENDER_RADIUS = 1;   // 与任意棋子相邻（见 defenderMoves 注释）

    /**
     * 攻方威胁着法：能成四（Kill.fourMoves）∪ 能成活三。
     * 返回按「四优先、活三次之、同优先级按索引升序」的确定序列。
     */
    function threatMoves(board, p, limit) {
        const fours = Kill.fourMoves(board, p, limit);
        const cells = board.cells;
        const nb = board.neighbor;
        const shapeBuf = new Int8Array(4);
        const seen = {};
        const out = [];
        for (let k = 0; k < fours.length; k++) { seen[fours[k]] = true; out.push(fours[k]); }

        const threes = [];
        for (let y = PAD; y < PAD + SIZE; y++) {
            const rowBase = y * W;
            for (let x = PAD; x < PAD + SIZE; x++) {
                const idx = rowBase + x;
                if (cells[idx] !== EMPTY || seen[idx] || nb[idx] === 0) continue;
                Ev.pointShapes(board, idx, p, shapeBuf);
                for (let d = 0; d < 4; d++) {
                    if (shapeBuf[d] === SHAPE.OPEN_THREE) { threes.push(idx); break; }
                }
            }
        }
        for (let k = 0; k < threes.length && out.length < (limit || 24) * 2; k++) out.push(threes[k]);
        return out;
    }

    /**
     * 防守应手集：与任意棋子相邻的空点（neighbor > 0，确定性升序）。
     * 完备性：任何「挡三点 / 反冲四点」都与同色既有子相邻（成四/成五的点
     * 一定落在含已有子的 5 格窗内），集合外的闲着不改变攻方下一手的
     * 强制性质 —— 见模块注释第 3 条。
     */
    function defenderMoves(board) {
        const cells = board.cells;
        const nb = board.neighbor;
        const out = [];
        for (let y = PAD; y < PAD + SIZE; y++) {
            const rowBase = y * W;
            for (let x = PAD; x < PAD + SIZE; x++) {
                const idx = rowBase + x;
                if (cells[idx] !== EMPTY) continue;
                if (nb[idx] === 0) continue;                 // 与所有棋子都不相邻：闲着
                out.push(idx);
            }
        }
        return out;
    }

    /** 防手是否给防守方带来成五点（反冲四） */
    function makesOwnFour(board, i, opp) {
        const buf = new Int32Array(8);
        return Kill.fivePoints(board, i, opp, buf) >= 1;
    }

    /**
     * VCT 求解。
     *
     * @param {object} board  引擎棋盘（已载入局面）
     * @param {number} p      进攻方
     * @param {object} [opts] { maxDepth=6, nodeBudget=60000 }
     * @returns {{move:number, depth:number, nodes:number}|null}
     *          null = 预算内未证明必胜（不等于必不胜）
     */
    function solve(board, p, opts) {
        opts = opts || {};
        const maxDepth = opts.maxDepth || 6;
        const state = { nodes: 0, budget: opts.nodeBudget || 60000, depth: 0 };
        const buf = new Int32Array(8);
        const opp = C.opp(p);
        // 预算走「异常跳出递归」，栈上每层的 place 都来不及撤销 ——
        // 与 v1 的教训同源：用 history 基准在 finally 里把棋盘滚回去，
        // 保证调用方的 board 绝对不留幽灵棋子。
        const baseLen = board.history.length;

        try {
            const m = attack(maxDepth);
            if (m >= 0) return { move: m, depth: state.depth, nodes: state.nodes };
            return null;
        } catch (e) {
            if (e && e.__budget) return null;   // 预算耗尽：不宣称
            throw e;
        } finally {
            while (board.history.length > baseLen) board.unplace();
        }

        /** OR 节点：攻方行棋，找一手能证明必胜的威胁 */
        function attack(depth) {
            if (++state.nodes > state.budget) throw { __budget: true };
            if (depth <= 0) return -1;

            const moves = threatMoves(board, p, 24);
            for (let k = 0; k < moves.length; k++) {
                const m = moves[k];
                board.place(m, p);

                // 直接成五
                if (board.isFive(m)) {
                    board.unplace();
                    state.depth = Math.max(state.depth, maxDepth - depth + 1);
                    return m;
                }

                const nFive = Kill.fivePoints(board, m, p, buf);
                if (nFive >= 2) {
                    // 活四 / 双四：防不胜防
                    board.unplace();
                    state.depth = Math.max(state.depth, maxDepth - depth + 1);
                    return m;
                }

                if (nFive === 1) {
                    // 冲四：强制应手（同 VCF）。挡后若防守方借挡形成反四且攻方无立即成五，
                    // 链条断 —— 与 kill.vcf 同一条保守规则。
                    const block = buf[0];
                    board.place(block, opp);
                    let ok = false;
                    if (!Kill.underThreat(board, opp) || board.count(p, SHAPE.FIVE) > 0) {
                        ok = attack(depth - 1) >= 0;
                    }
                    board.unplace();   // 撤挡
                    board.unplace();   // 撤四
                    if (ok) {
                        state.depth = Math.max(state.depth, maxDepth - depth + 1);
                        return m;
                    }
                    continue;
                }

                // 无四：必须是活三才值得展开 AND 节点（候选集已保证）
                board.unplace();
                if (!isOpenThreeMove(m)) continue;
                board.place(m, p);

                let allLose = true;
                const defs = defenderMoves(board);
                for (let d = 0; d < defs.length; d++) {
                    const dv = defs[d];
                    board.place(dv, opp);
                    // 反冲四直接打断攻方链条（保守规则，见模块注释第 4 条）
                    let sub = -1;
                    if (!makesOwnFour(board, dv, opp)) {
                        sub = attack(depth - 1);
                    }
                    board.unplace();
                    if (sub < 0) { allLose = false; break; }
                    if (++state.nodes > state.budget) { board.unplace(); throw { __budget: true }; }
                }
                board.unplace();   // 撤攻方三
                if (allLose && defs.length > 0) {
                    state.depth = Math.max(state.depth, maxDepth - depth + 1);
                    return m;
                }
            }
            return -1;
        }

        /** m 是否为活三着法（假设已撤销，重新假设落子判定） */
        function isOpenThreeMove(m) {
            const shapeBuf = new Int8Array(4);
            Ev.pointShapes(board, m, p, shapeBuf);
            for (let d = 0; d < 4; d++) if (shapeBuf[d] === SHAPE.OPEN_THREE) return true;
            return false;
        }
    }

    /**
     * 防守方最强应手（练习模式的自动防手，必须确定性）。
     * 优先级：挡攻方成五点 > 反冲四 > 挡活三（占攻方四点）> 近域首个空点。
     *
     * @param {object} board 引擎棋盘
     * @param {number} p     攻方（防守方取其对家）
     * @returns {number} 填充索引
     */
    function bestDefense(board, p) {
        const opp = C.opp(p);
        const buf = new Int32Array(8);

        // 1) 攻方已有成五点 → 唯一应手是挡（取第一个，攻方多五点时已无从救）
        {
            const cells = board.cells;
            for (let y = PAD; y < PAD + SIZE; y++) {
                const rowBase = y * W;
                for (let x = PAD; x < PAD + SIZE; x++) {
                    const idx = rowBase + x;
                    if (cells[idx] !== EMPTY) continue;
                    if (Ev.isWinningPoint(board, idx, p)) return idx;
                }
            }
        }
        // 2) 反冲四
        {
            const defs = defenderMoves(board);
            for (let k = 0; k < defs.length; k++) {
                board.place(defs[k], opp);
                const n = Kill.fivePoints(board, defs[k], opp, buf);
                board.unplace();
                if (n >= 1) return defs[k];
            }
        }
        // 3) 挡活三：占攻方能成四的点
        {
            const fours = Kill.fourMoves(board, p, 8);
            if (fours.length > 0) return fours[0];
        }
        // 4) 近域首个空点
        {
            const defs = defenderMoves(board);
            if (defs.length > 0) return defs[0];
        }
        return C.idx(7, 7);
    }

    const TSS = { solve, threatMoves, defenderMoves, bestDefense, DEFENDER_RADIUS };

    root.GMK.TSS = TSS;
    if (typeof module !== 'undefined' && module.exports) module.exports = TSS;
})();
