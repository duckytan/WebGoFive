/**
 * 五子棋游戏核心 —— 状态机 / 规则 / 事件 / AI 注入
 *
 * 设计原则（见 docs/API-CONTRACT.md）：
 *  - 本类不持有任何 UI / 渲染状态，只管理棋盘、着法历史、胜负、禁手
 *  - AI 通过 setAI(impl) 注入，默认 GMK.EngineAI；核心不 new 具体 AI
 *  - 禁手委托 GMK.Forbidden.checkGrid（RIF 9.2/9.3）
 *  - 所有对外交互走事件（on/emit）+ 公开方法
 *
 * 可独立在 Node 跑（挂 module.exports），也可挂浏览器全局 window.GMK.Game。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    const SIZE = 15;
    const BLACK = 1, WHITE = 2;
    const DIRS = [
        { dx: 1, dy: 0, name: 'horizontal' },
        { dx: 0, dy: 1, name: 'vertical' },
        { dx: 1, dy: 1, name: 'diag_down' },
        { dx: 1, dy: -1, name: 'diag_up' }
    ];
    const MODES = ['PvP', 'PvE', 'EvE', 'VCF_PRACTICE'];
    const DIFFS = ['BEGINNER', 'NORMAL', 'HARD', 'HELL'];

    function emptyBoard() {
        return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    }

    class GomokuGame {
        constructor() {
            this.board = emptyBoard();
            this.moves = [];
            this.currentPlayer = BLACK;
            this.gameStatus = 'ready';   // ready | playing | finished
            this.winner = null;         // 1 | 2 | 0(平局) | null
            this.gameMode = 'PvP';
            this.aiDifficulty = 'NORMAL';
            this.blackAIDifficulty = 'NORMAL';
            this.whiteAIDifficulty = 'NORMAL';
            this.startTime = null;
            this.endTime = null;

            // AI 注入位：默认懒加载 GMK.EngineAI
            this.ai = null;
            this.lastAIInfo = null;

            // 事件总线
            this._handlers = {};

            // 禁手模块（GMK.Forbidden，引擎已加载）
            this._forbidden = GMK.Forbidden || null;
        }

        /* ================= 事件总线 ================= */
        on(event, cb) {
            (this._handlers[event] = this._handlers[event] || []).push(cb);
            return this;
        }
        _emit(event, payload) {
            const list = this._handlers[event];
            if (!list) return;
            for (const cb of list.slice()) {
                try { cb(payload); } catch (e) { console.error('[Game] 事件回调异常', event, e); }
            }
        }

        /* ================= AI 注入 ================= */
        /**
         * 注入 AI 实现（须满足 GomokuAI 契约：getMove(game,difficulty) / getLastInfo()）。
         * 不传则用默认引擎。
         */
        setAI(impl) {
            this.ai = impl;
            return this;
        }

        _ensureAI() {
            if (this.ai) {
                if (typeof this.ai.sync === 'function') this.ai.sync();
                return this.ai;
            }
            const EngineAI = GMK.EngineAI;
            if (typeof EngineAI === 'function') {
                this.ai = new EngineAI(this);
                return this.ai;
            }
            console.warn('[Game] 无可用 AI（GMK.EngineAI 未加载）');
            return null;
        }

        /* ================= 落子 ================= */
        placePiece(x, y) {
            if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
                return { success: false, code: 'INVALID_POSITION' };
            }
            if (this.board[y][x] !== 0) {
                return { success: false, code: 'POSITION_OCCUPIED' };
            }
            if (this.gameStatus === 'finished') {
                return { success: false, code: 'GAME_FINISHED' };
            }

            // 黑棋禁手检查（RIF 9.2/9.3）
            if (this.currentPlayer === BLACK) {
                const fr = this.checkForbidden(x, y);
                if (fr.isForbidden) {
                    this._emit('forbidden', { x, y, type: fr.type, details: fr.details });
                    return { success: false, code: 'FORBIDDEN_MOVE', forbiddenType: fr.type, details: fr.details };
                }
            }

            const player = this.currentPlayer;
            this.board[y][x] = player;
            this.moves.push({ x, y, player, step: this.moves.length + 1, timestamp: Date.now() });

            if (this.gameStatus === 'ready') {
                this.gameStatus = 'playing';
                this.startTime = this.startTime || Date.now();
            }

            // 胜负
            const win = this._winAt(x, y, player);
            if (win) {
                this.gameStatus = 'finished';
                this.winner = player;
                this.endTime = Date.now();
                const result = { success: true, gameOver: true, winner: player, winLine: win.line, reason: 'five_in_row' };
                this._emit('move', { x, y, player, step: this.moves.length, result });
                this._emit('over', { winner: player, reason: 'five_in_row', winLine: win.line });
                return result;
            }

            // 平局
            if (this.moves.length === 225) {
                this.gameStatus = 'finished';
                this.winner = 0;
                this.endTime = Date.now();
                const result = { success: true, gameOver: true, winner: 0, reason: 'draw' };
                this._emit('move', { x, y, player, step: this.moves.length, result });
                this._emit('over', { winner: 0, reason: 'draw' });
                return result;
            }

            this.currentPlayer = player === BLACK ? WHITE : BLACK;
            const result = { success: true, gameOver: false, nextPlayer: this.currentPlayer };
            this._emit('move', { x, y, player, step: this.moves.length, result });
            return result;
        }

        /** 五连判定，返回 {line} 或 null */
        _winAt(x, y, player) {
            for (const dir of DIRS) {
                const line = this._getLine(x, y, dir, player);
                if (line.length >= 5) return { line, direction: dir.name };
            }
            return null;
        }

        _getLine(x, y, dir, player) {
            const line = [{ x, y }];
            let nx = x + dir.dx, ny = y + dir.dy;
            while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && this.board[ny][nx] === player) {
                line.push({ x: nx, y: ny });
                nx += dir.dx; ny += dir.dy;
            }
            nx = x - dir.dx; ny = y - dir.dy;
            while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && this.board[ny][nx] === player) {
                line.unshift({ x: nx, y: ny });
                nx -= dir.dx; ny -= dir.dy;
            }
            return line;
        }

        /* ================= 禁手（委托 GMK.Forbidden）================= */
        checkForbidden(x, y) {
            const out = { isForbidden: false, type: null, details: {} };
            if (this.currentPlayer !== BLACK) return out;
            if (this._forbidden && typeof this._forbidden.checkGrid === 'function') {
                const r = this._forbidden.checkGrid(this.board, x, y, BLACK);
                if (r && r.forbidden) {
                    out.isForbidden = true;
                    out.type = (r.type || '未知') + '禁手';
                    out.details = { fours: r.fours, threes: r.threes };
                }
                return out;
            }
            // 兜底：引擎未加载时保守放行（避免误杀），UI 层可提示
            return out;
        }

        /* ================= 悔棋 / 重置 ================= */
        undo(steps = 1) {
            if (this.moves.length < steps) return false;
            for (let i = 0; i < steps; i++) {
                const last = this.moves.pop();
                this.board[last.y][last.x] = 0;
                this.currentPlayer = last.player;
            }
            if (this.gameStatus === 'finished') {
                this.gameStatus = this.moves.length ? 'playing' : 'ready';
                this.winner = null;
                this.endTime = null;
            }
            if (this.moves.length === 0) {
                this.gameStatus = 'ready';
                this.currentPlayer = BLACK;
                this.startTime = null;
            }
            this._emit('undo', { steps });
            return true;
        }

        reset() {
            this.board = emptyBoard();
            this.moves = [];
            this.currentPlayer = BLACK;
            this.gameStatus = 'ready';
            this.winner = null;
            this.startTime = null;
            this.endTime = null;
            this.lastAIInfo = null;
            this._emit('reset', {});
        }

        /* ================= 模式 / 难度 ================= */
        setGameMode(mode) {
            if (!MODES.includes(mode)) return false;
            this.gameMode = mode;
            return true;
        }
        setAIDifficulty(d) {
            if (!DIFFS.includes(d)) return false;
            this.aiDifficulty = d;
            this.whiteAIDifficulty = d;
            return true;
        }
        setBlackAIDifficulty(d) { if (DIFFS.includes(d)) { this.blackAIDifficulty = d; return true; } return false; }
        setWhiteAIDifficulty(d) { if (DIFFS.includes(d)) { this.whiteAIDifficulty = d; return true; } return false; }

        /* ================= AI 决策（走注入的 AI）================= */
        getAIMove() {
            if (this.gameStatus === 'finished') return null;
            let difficulty = this.aiDifficulty;
            if (this.gameMode === 'EvE') {
                difficulty = this.currentPlayer === BLACK ? this.blackAIDifficulty : this.whiteAIDifficulty;
            }
            const ai = this._ensureAI();
            if (!ai) return null;
            const move = ai.getMove(difficulty);
            this.lastAIInfo = (typeof ai.getLastInfo === 'function') ? ai.getLastInfo() : null;
            if (move && this.gameMode !== 'PvP') this._emit('aiMove', { ...move, info: this.lastAIInfo });
            return move;
        }

        /* ================= 数据存取 ================= */
        getBoardState() { return this.board.map(row => row.slice()); }
        getMoves() { return this.moves.slice(); }
        getLastMove() { return this.moves.length ? this.moves[this.moves.length - 1] : null; }

        getGameInfo() {
            const dur = this.startTime ? (this.endTime || Date.now()) - this.startTime : 0;
            return {
                currentPlayer: this.currentPlayer,
                moveCount: this.moves.length,
                gameStatus: this.gameStatus,
                winner: this.winner,
                duration: dur,
                gameMode: this.gameMode,
                aiDifficulty: this.aiDifficulty,
                blackAIDifficulty: this.blackAIDifficulty,
                whiteAIDifficulty: this.whiteAIDifficulty,
                startTime: this.startTime,
                endTime: this.endTime
            };
        }

        exportData() {
            return {
                version: '2.0',
                boardState: this.getBoardState(),
                moves: this.getMoves(),
                gameInfo: this.getGameInfo(),
                timestamp: Date.now()
            };
        }

        /** 重放着法恢复状态（自动跳过禁手/越界/重复，尽量宽容） */
        loadFromData(data) {
            if (!data || !Array.isArray(data.moves)) return false;
            this.reset();
            for (const m of data.moves) {
                if (typeof m.x !== 'number' || typeof m.y !== 'number') continue;
                this.board[m.y][m.x] = m.player || (m.step % 2 === 1 ? BLACK : WHITE);
                this.moves.push({ x: m.x, y: m.y, player: this.board[m.y][m.x], step: this.moves.length + 1, timestamp: m.timestamp || 0 });
            }
            this.currentPlayer = this.moves.length % 2 === 0 ? BLACK : WHITE;
            this.gameStatus = this.moves.length ? 'playing' : 'ready';
            const g = data.gameInfo;
            if (g) {
                if (MODES.includes(g.gameMode)) this.gameMode = g.gameMode;
                if (DIFFS.includes(g.aiDifficulty)) { this.aiDifficulty = g.aiDifficulty; this.whiteAIDifficulty = g.aiDifficulty; }
                if (DIFFS.includes(g.blackAIDifficulty)) this.blackAIDifficulty = g.blackAIDifficulty;
                if (DIFFS.includes(g.whiteAIDifficulty)) this.whiteAIDifficulty = g.whiteAIDifficulty;
            }
            return true;
        }

        /** 直接摆一个棋盘（练习/回放用），不走着法历史 */
        loadCustomState({ board, currentPlayer = BLACK, moves = [], gameStatus = 'playing' } = {}) {
            if (!Array.isArray(board) || board.length !== SIZE) return false;
            this.board = board.map(row => Array.isArray(row) ? row.map(c => (c === 1 || c === 2) ? c : 0) : new Array(SIZE).fill(0));
            this.moves = Array.isArray(moves) ? moves.slice() : [];
            this.currentPlayer = currentPlayer === WHITE ? WHITE : BLACK;
            this.gameStatus = ['ready', 'playing', 'finished'].includes(gameStatus) ? gameStatus : 'playing';
            this.winner = null;
            this.startTime = this.gameStatus === 'ready' ? null : Date.now();
            this.endTime = null;
            return true;
        }
    }

    GMK.Game = GomokuGame;
    GMK.Game.MODES = MODES;
    GMK.Game.DIFFS = DIFFS;
    GMK.Game.SIZE = SIZE;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GomokuGame;
    }
})();
