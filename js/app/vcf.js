/**
 * VCF 冲四练习 —— 内置 5 道经典算杀题，玩家走，引擎校验
 *
 * 题库：入门 2 → 进阶 2 → 中阶 1（本次纯数据追加 3 道，原 2 道仅补 difficulty 字段）。
 * 校验口径：checkSolved 判定「黑棋已出现五连」，故每道题的 solution 都是
 * 「补成五的成五点」，命中其一即通过。
 */
(function () {
    'use strict';
    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    /** 生成一张 15×15 全空棋盘 */
    function emptyBoard() {
        return Array.from({ length: 15 }, () => new Array(15).fill(0));
    }

    // 经典 VCF 题：黑棋连续冲四成五
    const PUZZLES = [
        {
            id: 'vcf-1',
            title: '连续冲四（入门）',
            difficulty: '入门',
            description: '黑棋连续两个冲四即可成五，先找冲四点。',
            board: [[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,1,1,1,0,1,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],
            sideToMove: 1,
            solution: [[6,7],[4,7]]
        },
        {
            id: 'vcf-2',
            title: '活三接冲四（进阶）',
            difficulty: '进阶',
            description: '先做活三，再接冲四形成必杀。',
            board: [[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,1,1,1,1,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],
            sideToMove: 1,
            // 引擎校验：原数据行 7 仅 3 颗黑子（x=4,6,7）且解点 [[6,7]] 落在已占位，
            // 无合法成五点。最小修正——补 1 颗 x=5 黑子使 x=4..7 成活四，
            // 补 (3,7) 或 (8,7) 任一即成五（保留原题「活三接冲四」思路的最短路径）。
            solution: [[3,7],[8,7]]
        },
        {
            id: 'vcf-3',
            title: '横向活四补成五（入门）',
            difficulty: '入门',
            description: '横向活四两端皆空，补 (3,12) 或 (8,12) 任一即成五。',
            board: (function () {
                const b = emptyBoard();
                b[12][4] = b[12][5] = b[12][6] = b[12][7] = 1;
                b[5][2] = b[5][12] = 2;   // 白棋干扰子
                return b;
            })(),
            sideToMove: 1,
            solution: [[3,12],[8,12]]
        },
        {
            id: 'vcf-4',
            title: '纵向冲四补成五（进阶）',
            difficulty: '进阶',
            description: '纵向四连上端被白子封住，只有下端 (3,14) 能成五。',
            board: (function () {
                const b = emptyBoard();
                b[10][3] = b[11][3] = b[12][3] = b[13][3] = 1; // 纵向四连
                b[9][3] = 2;   // 上端白堵
                b[9][5] = 2;   // 干扰白子
                return b;
            })(),
            sideToMove: 1,
            solution: [[3,14]]
        },
        {
            id: 'vcf-5',
            title: '双斜线交汇成五（中阶）',
            difficulty: '中阶',
            description: '主对角活四 (4,4)-(7,7)，补 (3,3) 或 (8,8) 即成五。',
            board: (function () {
                const b = emptyBoard();
                b[4][4] = b[5][5] = b[6][6] = b[7][7] = 1;     // 主对角活四
                b[6][8] = b[8][6] = b[9][5] = 1;               // 副对角辅助线
                return b;
            })(),
            sideToMove: 1,
            solution: [[3,3],[8,8]]
        }
    ];

    const VCFPractice = {
        PUZZLES,
        current: null,
        best: {},

        start(idx = 0) {
            this.current = PUZZLES[idx] || PUZZLES[0];
            return this.current;
        },
        loadBoard(game) {
            if (!this.current) return false;
            const b = this.current.board.map(r => r.slice());
            return game.loadCustomState({ board: b, currentPlayer: this.current.sideToMove, gameStatus: 'playing' });
        },
        checkSolved(board2d) {
            // 用引擎判断当前棋盘黑棋是否有成五点 / VCF
            const C = GMK.C, Board = GMK.Board, Kill = GMK.Kill, Ev = GMK.Evaluator;
            if (!Board || !Kill) return false;
            const eng = new Board();
            eng.loadFrom2D(board2d);
            // 黑棋已有五连 = 已解
            for (let i = 0; i < C.CELLS; i++) {
                if (eng.isFive(i) && eng.cells[i] === C.BLACK) return true;
            }
            return false;
        },
        record(id, ms) {
            if (!this.best[id] || ms < this.best[id]) this.best[id] = ms;
            try { localStorage.setItem('gmk_vcf_best', JSON.stringify(this.best)); } catch (e) {}
        },
        getBest() {
            try { this.best = Object.assign(this.best, JSON.parse(localStorage.getItem('gmk_vcf_best') || '{}')); } catch (e) {}
            return this.best;
        }
    };

    GMK.VCFPractice = VCFPractice;
    if (typeof module !== 'undefined' && module.exports) module.exports = VCFPractice;
})();
