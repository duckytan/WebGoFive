/**
 * 回放器 —— 步进 / 快进 / 跳步，纯消费 moves 历史，不碰游戏状态
 */
(function () {
    'use strict';
    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    class Replayer {
        /**
         * @param {Array} moves  着法历史（来自 game.getMoves() 或存档）
         * @param {object} [opts] { onFrame(board2d, idx), speed=400 }
         */
        constructor(moves, opts = {}) {
            this.moves = (moves || []).slice();
            this.total = this.moves.length;
            this.idx = -1;
            this.playing = false;
            this.speed = opts.speed || 400;
            this._onFrame = opts.onFrame || null;
            this._timer = null;
        }

        _boardAt(idx) {
            const b = Array.from({ length: 15 }, () => new Array(15).fill(0));
            for (let i = 0; i <= idx && i < this.total; i++) {
                const m = this.moves[i];
                if (m && typeof m.x === 'number') b[m.y][m.x] = m.player || (i % 2 === 0 ? 1 : 2);
            }
            return b;
        }

        _emit() {
            if (this._onFrame) this._onFrame(this._boardAt(this.idx), Math.max(0, this.idx));
        }

        step() {
            if (this.idx < this.total - 1) { this.idx++; this._emit(); }
            return this.idx;
        }
        back() {
            if (this.idx > 0) { this.idx--; this._emit(); }
            else this.idx = -1, this._emit();
            return this.idx;
        }
        first() { this.idx = -1; this._emit(); return this.idx; }
        last() { this.idx = this.total - 1; this._emit(); return this.idx; }
        goto(i) { this.idx = Math.max(-1, Math.min(this.total - 1, i)); this._emit(); return this.idx; }

        play() {
            if (this.playing) return;
            if (this.idx >= this.total - 1) this.idx = -1;
            this.playing = true;
            this._timer = setInterval(() => {
                if (this.idx >= this.total - 1) { this.pause(); return; }
                this.step();
            }, this.speed);
        }
        pause() {
            this.playing = false;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
        }
        setSpeed(ms) {
            this.speed = ms;
            if (this.playing) { this.pause(); this.play(); }
        }
        destroy() { this.pause(); }

        get position() { return Math.max(0, this.idx + 1); }
        get isEnd() { return this.idx >= this.total - 1; }
        get isEmpty() { return this.total === 0; }
    }

    GMK.Replayer = Replayer;
    if (typeof module !== 'undefined' && module.exports) module.exports = Replayer;
})();
