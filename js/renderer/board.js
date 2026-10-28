/**
 * 棋盘渲染器 —— 纯 board2d → 画布，不持任何游戏状态
 *
 * 特性：
 *  - DPR 高分屏（devicePixelRatio）感知，点击坐标 rect→cell 换算
 *  - 主题调色板（light / dark / wood）
 *  - 悬停预览 / AI 提示高亮 / 禁手高亮 / 坐标开关 / 五连高亮
 *
 * 契约（见 docs/API-CONTRACT.md §4）：
 *  - render(board2d, opts)  opts: { lastMove?, hint?, forbidden?, winLine? }
 *  - on('click'|'hover', ({x,y}) => {})
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    const THEMES = {
        wood:  { bg: '#e8c98f', bg2: '#d4a574', line: '#5a3a1a', star: '#5a3a1a',
                 black: ['#3a3a3a', '#0a0a0a'], white: ['#ffffff', '#dcdcdc'], text: '#3a2a15' },
        dark:  { bg: '#1c2333', bg2: '#141a28', line: '#3a4a6a', star: '#5a7ab8',
                 black: ['#2a2a2a', '#050505'], white: ['#f8f8f8', '#c8c8c8'], text: '#d8e2f4' },
        light: { bg: '#f6f1e7', bg2: '#efe6d5', line: '#8a7a5a', star: '#8a7a5a',
                 black: ['#2a2a2a', '#080808'], white: ['#ffffff', '#e0e0e0'], text: '#4a3a25' }
    };

    class BoardRenderer {
        /**
         * @param {HTMLCanvasElement} canvas
         * @param {object} [opts] { theme='wood', boardSize=15, cellSize=36, padding=30, showCoords=true }
         */
        constructor(canvas, opts = {}) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.boardSize = opts.boardSize || 15;
            this.cellSize = opts.cellSize || 36;
            this.padding = opts.padding || 30;

            // 画布内部尺寸（不含 DPR）
            this.canvasWidth = this.padding * 2 + this.cellSize * (this.boardSize - 1);
            this.canvasHeight = this.canvasWidth;
            this.theme = opts.theme || 'wood';
            this.showCoords = opts.showCoords !== false;

            // 高亮状态
            this.hover = null;        // {x,y}
            this.hint = null;         // {x,y}
            this.forbiddenPoint = null;
            this.winLine = null;
            this.threat = null;       // {x,y} 威胁点（对手一步成五处，红色描边圈）

            // 事件订阅（由外部 .on 管理）
            this._listeners = { click: [], hover: [] };

            this._resize();
            this._bindEvents();
            this._log('初始化完成', this.theme, '画布', this.canvasWidth + '×' + this.canvasHeight, 'DPR', window.devicePixelRatio || 1);
        }

        _log(...args) { if (this._verbose) console.log('[Renderer]', ...args); }

        /** 按主题 + DPR 重设画布物理尺寸 */
        _resize() {
            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            this.dpr = dpr;
            this.canvas.width = Math.round(this.canvasWidth * dpr);
            this.canvas.height = Math.round(this.canvasHeight * dpr);
            // 视觉尺寸交给 CSS，这里保留 CSS 控制
        }

        setTheme(name) {
            if (THEMES[name]) { this.theme = name; this.render(this._lastBoard || [], {}); }
            return this;
        }
        setShowCoords(b) { this.showCoords = !!b; this.render(this._lastBoard || [], {}); return this; }
        setVerbose(b) { this._verbose = !!b; return this; }

        _bindEvents() {
            this.canvas.addEventListener('click', e => {
                const c = this._eventToCell(e);
                if (c && c.x >= 0 && c.x < this.boardSize && c.y >= 0 && c.y < this.boardSize) {
                    for (const cb of this._listeners.click.slice()) { try { cb(c); } catch (err) { console.error(err); } }
                }
            });
            this.canvas.addEventListener('mousemove', e => {
                const c = this._eventToCell(e);
                this.hover = (c && c.x >= 0 && c.x < this.boardSize && c.y >= 0 && c.y < this.boardSize) ? c : null;
                for (const cb of this._listeners.hover.slice()) { try { cb(this.hover || {}); } catch (err) { console.error(err); } }
                this.render(this._lastBoard || [], this._lastOpts || {});
            });
            this.canvas.addEventListener('mouseleave', () => {
                this.hover = null;
                this.render(this._lastBoard || [], this._lastOpts || {});
            });
        }

        /** CSS 像素 → 棋盘坐标（核心：rect 与 canvas 内部尺寸的换算） */
        _eventToCell(e) {
            const rect = this.canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const scaleX = this.canvas.width / (rect.width * this.dpr);  // canvas.width 已含 DPR
            const scaleY = this.canvas.height / (rect.height * this.dpr);
            const lx = (e.clientX - rect.left) * this.dpr * scaleX;
            const ly = (e.clientY - rect.top) * this.dpr * scaleY;
            const gx = Math.round((lx - this.padding * this.dpr) / (this.cellSize * this.dpr));
            const gy = Math.round((ly - this.padding * this.dpr) / (this.cellSize * this.dpr));
            return { x: gx, y: gy };
        }

        on(event, cb) { if (this._listeners[event]) this._listeners[event].push(cb); return this; }
        off(event, cb) {
            if (!this._listeners[event]) return this;
            const i = this._listeners[event].indexOf(cb);
            if (i >= 0) this._listeners[event].splice(i, 1);
            return this;
        }

        setHint(pt) { this.hint = pt; this.render(this._lastBoard || [], this._lastOpts || {}); }
        clearHint() { this.hint = null; this.render(this._lastBoard || [], this._lastOpts || {}); }
        setForbiddenPoint(pt) { this.forbiddenPoint = pt; this.render(this._lastBoard || [], this._lastOpts || {}); }
        setWinLine(line) { this.winLine = line; }

        /** 主渲染入口 */
        render(board, opts = {}) {
            this._lastBoard = board;
            this._lastOpts = opts;
            this.threat = (opts && opts.threat) ? opts.threat : null; // 威胁点（对手一步成五处）
            const t = THEMES[this.theme] || THEMES.wood;
            const dpr = this.dpr;
            const ctx = this.ctx;

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

            // 背景
            const bg = ctx.createLinearGradient(0, 0, this.canvasWidth, this.canvasHeight);
            bg.addColorStop(0, t.bg);
            bg.addColorStop(1, t.bg2);
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

            this._drawGrid(t);
            this._drawStarPoints(t);
            this._drawCoords(t);
            if (opts.lastMove) this._drawLastMoveMark(opts.lastMove);
            this._drawPieces(board, t);
            if (this.winLine && this.winLine.length) this._drawWinLine(this.winLine, t);
            if (this.hint) this._drawHint(this.hint, t);
            if (this.threat) this._drawThreat(this.threat, t);
            if (this.forbiddenPoint) this._drawForbidden(this.forbiddenPoint, t);
            if (this.hover && board[this.hover.y] && board[this.hover.y][this.hover.x] === 0) this._drawHover(this.hover, t);

            ctx.restore();
        }

        _px(n) { return this.padding + n * this.cellSize; }

        _drawGrid(t) {
            const ctx = this.ctx, cs = this.cellSize, n = this.boardSize;
            ctx.strokeStyle = t.line;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < n; i++) {
                const p = this._px(i);
                ctx.moveTo(this._px(0), p); ctx.lineTo(this._px(n - 1), p); // 横
                ctx.moveTo(p, this._px(0)); ctx.lineTo(p, this._px(n - 1)); // 竖
            }
            ctx.stroke();
        }

        _drawStarPoints(t) {
            const ctx = this.ctx;
            const pts = [[3,3],[3,11],[11,3],[11,11],[7,7]];
            ctx.fillStyle = t.star;
            for (const [x, y] of pts) {
                if (x >= this.boardSize || y >= this.boardSize) continue;
                ctx.beginPath();
                ctx.arc(this._px(x), this._px(y), 3.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        _drawCoords(t) {
            if (!this.showCoords) return;
            const ctx = this.ctx, n = this.boardSize;
            ctx.fillStyle = t.text;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const letters = 'ABCDEFGHIJKLMNO';
            for (let i = 0; i < n; i++) {
                const p = this._px(i);
                ctx.fillText(letters[i], p, this._px(0) - 18);
                ctx.fillText(String(i + 1), this._px(0) - 18, p);
            }
        }

        _drawPieces(board, t) {
            const ctx = this.ctx, r = this.cellSize * 0.42;
            for (let y = 0; y < board.length; y++) {
                for (let x = 0; x < board[y].length; x++) {
                    const v = board[y][x];
                    if (!v) continue;
                    const cx = this._px(x), cy = this._px(y);
                    const [c0, c1] = v === 1 ? t.black : t.white;
                    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
                    g.addColorStop(0, c0); g.addColorStop(1, c1);
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    ctx.fillStyle = g; ctx.fill();
                    ctx.lineWidth = 0.5;
                    ctx.strokeStyle = v === 1 ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.25)';
                    ctx.stroke();
                }
            }
        }

        _drawLastMoveMark(move) {
            const ctx = this.ctx, r = this.cellSize * 0.18;
            const cx = this._px(move.x), cy = this._px(move.y);
            ctx.fillStyle = move.player === 1 ? '#ff5b4d' : '#e02f2f';
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        }

        _drawWinLine(line, t) {
            const ctx = this.ctx;
            ctx.strokeStyle = 'rgba(255,60,60,0.85)';
            ctx.lineWidth = 4; ctx.lineCap = 'round';
            ctx.beginPath();
            line.forEach((p, i) => { const X = this._px(p.x), Y = this._px(p.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
            ctx.stroke();
        }

        _drawHover(pt, t) {
            const ctx = this.ctx, r = this.cellSize * 0.42;
            ctx.fillStyle = 'rgba(120,180,255,0.35)';
            ctx.beginPath(); ctx.arc(this._px(pt.x), this._px(pt.y), r, 0, Math.PI * 2); ctx.fill();
        }

        _drawHint(pt, t) {
            const ctx = this.ctx, r = this.cellSize * 0.42;
            ctx.strokeStyle = '#37d0a0'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(this._px(pt.x), this._px(pt.y), r + 2, 0, Math.PI * 2); ctx.stroke();
        }

        /** 威胁点：对手一步即可成五的位置，红色描边圈（#ff3b3b，与禁手同色） */
        _drawThreat(pt, t) {
            const ctx = this.ctx, r = this.cellSize * 0.42;
            const cx = this._px(pt.x), cy = this._px(pt.y);
            ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.stroke();
            // 中心小点提示
            ctx.fillStyle = 'rgba(255,59,59,0.35)';
            ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.fill();
        }

        _drawForbidden(pt, t) {
            const ctx = this.ctx, s = this.cellSize * 0.7;
            const x = this._px(pt.x), y = this._px(pt.y);
            ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
            ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
            ctx.stroke();
        }
    }

    GMK.Renderer = BoardRenderer;
    GMK.Renderer.THEMES = THEMES;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BoardRenderer;
    }
})();
