/**
 * 存档 / 读档 —— localStorage 自动保存 + 启动恢复
 */
(function () {
    'use strict';
    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});
    const KEY = 'gmk_autosave_v2';

    const SaveLoad = {
        KEY,
        save(game) {
            try { localStorage.setItem(KEY, JSON.stringify(game.exportData())); return true; }
            catch (e) { console.warn('[SaveLoad] 存档失败', e); return false; }
        },
        load() {
            try {
                const raw = localStorage.getItem(KEY);
                if (!raw) return null;
                return JSON.parse(raw);
            } catch (e) { console.warn('[SaveLoad] 读档失败', e); return null; }
        },
        hasSave() { return !!localStorage.getItem(KEY); },
        clear() { localStorage.removeItem(KEY); },

        /** 启动时：有存档则恢复，返回是否恢复成功 */
        autoRestore(game) {
            if (!game || game.gameStatus === 'finished') return false;
            if (game.moves.length > 0) return false;   // 已有进行中的对局，不覆盖
            const data = this.load();
            if (!data || !Array.isArray(data.moves) || data.moves.length === 0) return false;
            return game.loadFromData(data);
        },

        /** 游戏结束时清理存档（可选） */
        onGameOver() { this.clear(); }
    };

    GMK.SaveLoad = SaveLoad;
    if (typeof module !== 'undefined' && module.exports) module.exports = SaveLoad;
})();
