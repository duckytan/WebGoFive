/**
 * UI 控制器 —— 把「核心 + 渲染器 + AI」粘合成可玩界面
 *
 * 依赖（按 docs/API-CONTRACT.md）：
 *  - GMK.Game / GMK.Renderer / GMK.EngineAI
 *  - DOM：index.html 里的元素 id（board-canvas / hint-message / 模式按钮 等）
 *
 * 本层不碰引擎内部，只调 game / renderer 公开方法 + 订阅 game.on 事件。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    const DIFF_LABELS = { BEGINNER: '入门', NORMAL: '普通', HARD: '困难', HELL: '地狱' };
    /** 引擎 lastAIInfo.source → 中文标签（P0 诊断展示） */
    const SOURCE_LABELS = { search: '搜索', vcf: '算杀', blunder: '防亏', win: '成五', block: '挡五' };

    /** 棋盘坐标 → 象限记法（A1..O15） */
    function cxy(x, y) { return String.fromCharCode(65 + x) + (y + 1); }

    class App {
        constructor() {
            this.game = new GMK.Game();
            // P2-5：App 自建引擎并包一层可调参 AI（非 HELL 原样委托，
            // HELL + 自定义参数走 getBestMove 透传）。TunableAI 缺席时
            // 核心按默认懒加载 EngineAI，行为与 v2.1 一致。
            if (GMK.TunableAI && typeof GMK.TunableAI.createWrapper === 'function') {
                this.engineAI = new GMK.EngineAI(this.game);
                this.aiWrapper = GMK.TunableAI.createWrapper(this.engineAI);
                this.game.setAI(this.aiWrapper);
            }
            this.renderer = new GMK.Renderer(document.getElementById('board-canvas'));
            this.renderer.setVerbose(false);
            this.theme = localStorage.getItem('gmk_theme') || 'wood';
            this.renderer.setTheme(this.theme);
            document.body.setAttribute('data-theme', this.theme);

            this.aiThinking = false;
            this._aiPending = false;   // 已排期、尚未真正开算
            this._aiRaf = 0;           // 等待「玩家这一手上屏」的帧句柄
            this._aiTimer = 0;         // 让出主线程后的搜索启动定时器
            this.eveAutoPlay = false;
            this.showHint = true;      // AI 推荐点提示开关
            this.showThreat = true;    // 威胁点（对手成五位）高亮开关
            this._currentThreat = null;
            this._evaluating = false;
            this.strengthOverride = null; // P2-5：HELL 高级参数（生效值，镜像 aiWrapper.override）
            this.vcfStartTs = 0;       // VCF 练习开始时间戳
            this.vcfPuzzle = null;     // 当前 VCF 题

            this._init();
        }

        _$(id) { return document.getElementById(id); }
        _show(id, show) { const el = this._$(id); if (el) el.style.display = show ? '' : 'none'; }

        _init() {
            this._bindRenderer();
            this._bindGameEvents();
            this._bindControls();
            this._bindAIEnhance();
            this._applySettingsFromStorage();
            this._hideLoading();
            this._updatePanelVisibility();
        }

        _hideLoading() {
            const ls = this._$('loading-screen');
            if (ls) ls.classList.add('hidden');
        }

        _bindRenderer() {
            this.renderer.on('click', ({ x, y }) => this._onPlayerClick(x, y));
            this.renderer.on('hover', ({ x, y }) => {
                this._$('cursor-indicator') && (this._$('cursor-indicator').textContent =
                    x >= 0 && x < 15 ? String.fromCharCode(65 + x) + String(y + 1) : '—');
            });
        }

        _bindGameEvents() {
            this.game.on('move', ({ result }) => {
                this._render();
                if (result.gameOver) { this._render(); this._showResult(result); }
            });
            this.game.on('forbidden', ({ x, y, type }) => {
                this.renderer.setForbiddenPoint({ x, y });
                this._hint('⚠️ 禁手：' + type + '，请换位置');
                setTimeout(() => this.renderer.setForbiddenPoint(null), 1200);
            });
            this.game.on('over', () => { this.eveAutoPlay = false; });
        }

        _bindControls() {
            const bind = (id, fn) => { const el = this._$(id); if (el) el.addEventListener('click', fn); };
            bind('new-game-btn', () => this.newGame());
            bind('undo-btn', () => this.undo());
            bind('replay-btn', () => this._show('replay-player', true));

            // 模式切换
            for (const m of ['PvP', 'PvE', 'EvE']) {
                const el = this._$('mode-' + m);
                if (el) el.addEventListener('click', () => this.setMode(m));
            }
            // 难度
            for (const d of GMK.Game.DIFFS) {
                const el = this._$('diff-' + d);
                if (el) el.addEventListener('click', () => this.setDifficulty(d));
            }
            // 主题
            for (const t of ['wood', 'dark', 'light']) {
                const el = this._$('theme-' + t);
                if (el) el.addEventListener('click', () => this.setTheme(t));
            }
            // 坐标开关
            const cc = this._$('toggle-coords');
            if (cc) cc.addEventListener('click', () => {
                const on = cc.classList.toggle('on');
                this.renderer.setShowCoords(on);
            });
        }

        _applySettingsFromStorage() {
            const mode = localStorage.getItem('gmk_mode');
            if (mode && GMK.Game.MODES.includes(mode)) this.setMode(mode, true);
            const diff = localStorage.getItem('gmk_diff');
            if (diff && GMK.Game.DIFFS.includes(diff)) this.setDifficulty(diff, true);
            const theme = localStorage.getItem('gmk_theme');
            if (theme) this.setTheme(theme, true);
        }

        /* ---------------- AI 增强（T4：分析面板 + 威胁高亮 + VCF 面板） ---------------- */

        /** 绑定 AI 分析面板 / 威胁开关 / 深度评估 / VCF 练习（全部 DOM 可选） */
        _bindAIEnhance() {
            // 深度评估按钮（同步搜索会卡主线程，必须先上屏遮罩再跑，见设计 §7）
            const deep = this._$('btn-deep-eval');
            if (deep) deep.addEventListener('click', () => this._runDeepEval());

            // P2-5：HELL 高级棋力选项面板
            this._bindStrengthAdvanced();

            // 最优着法提示开关 / 威胁提示开关
            const ht = this._$('chk-hint-toggle');
            if (ht) ht.addEventListener('change', () => {
                this.showHint = !!ht.checked;
                this._refreshAIOverlays();
            });
            const tt = this._$('chk-threat-toggle');
            if (tt) tt.addEventListener('change', () => {
                this.showThreat = !!tt.checked;
                this._refreshAIOverlays();
            });

            // VCF 练习面板：题目下拉 + 开始按钮
            const V = GMK.VCFPractice;
            const sel = this._$('vcf-puzzle-select');
            if (sel && V && Array.isArray(V.PUZZLES)) {
                for (let i = 0; i < V.PUZZLES.length; i++) {
                    const p = V.PUZZLES[i];
                    const opt = document.createElement('option');
                    opt.value = String(i);
                    opt.textContent = (i + 1) + '. ' + p.title + (p.difficulty ? '（' + p.difficulty + '）' : '');
                    if (sel.appendChild) sel.appendChild(opt);
                }
                this._renderVcfStatus();
            }
            const vstart = this._$('btn-vcf-start');
            if (vstart) vstart.addEventListener('click', () => this._startVcf());

            // 每步落子后：填 #ai-best-move + 威胁扫描 + 优势条（P0/P1）
            this.game.on('move', () => this._onMoveAfterHook());
            // 终局：清除威胁高亮 / 提示
            this.game.on('over', () => this._clearAIOverlays());
            // 棋盘被重置（含外部直接调用 reset() 的测试/工具场景）：
            // 立刻中止 EvE 自动对局链，避免已排队的单步继续往空盘上落子。
            // newGame() 内部先置 false 再 reset，随后由 _startEvE() 重新拉 true，
            // 故不会误伤正常「新对局」流程。
            this.game.on('reset', () => { this.eveAutoPlay = false; this._cancelAIThink(); });
        }

        /** 落子事件钩子：AI 分析 + 威胁高亮 + VCF 完成判定 */
        _onMoveAfterHook() {
            const g = this.game;
            const board = g.getBoardState();

            // ① VCF 练习：落子后校验是否已解
            //    ⚠ 顺序敏感：解开 VCF 的那一手本身必然成五 → placePiece 后
            //    gameStatus 立刻变 finished。旧实现把「终局早退」放在本段之前，
            //    于是「已解」永远不触发、record 也永远不写入。故本段必须前置。
            if (g.gameMode === 'VCF_PRACTICE' && this.vcfPuzzle && GMK.VCFPractice.checkSolved(board)) {
                const ms = this.vcfStartTs ? Date.now() - this.vcfStartTs : 0;
                GMK.VCFPractice.record(this.vcfPuzzle.id, ms);
                const best = GMK.VCFPractice.getBest()[this.vcfPuzzle.id];
                const st = this._$('vcf-status');
                if (st) st.textContent = '已解 · 用时 ' + ms + 'ms · 历史最佳 ' + (best || ms) + 'ms';
                this._hint('VCF 练习完成！');
                this.vcfPuzzle = null;
            }

            if (g.gameStatus === 'finished') { this._clearAIOverlays(); return; }
            if (!GMK.Analysis) return;

            // ② 威胁点：「对手」= 刚落子方（视角 = 当前行棋方的对手）
            if (this.showThreat && g.gameMode !== 'VCF_PRACTICE') {
                const justMoved = g.currentPlayer === 1 ? 2 : 1;
                this._currentThreat = GMK.Analysis.scanOpponentThreat(board, justMoved);
            } else {
                this._currentThreat = null;
            }

            // ③ 优势条（浅搜 200ms，设计 P1 轻量档；EvE 面板隐藏，跳过省主线程）
            if (g.gameMode !== 'EvE') {
                try {
                    this._paintAdvantage(GMK.Analysis.advantage(board, g.currentPlayer));
                } catch (e) { /* 分析层异常不阻塞对局 */ }
            }

            // ④ 分析面板：开局窗口（盘面 < 4 子）内优先显示定式推荐（P2-6）；
            //    出窗后 PvE 展示 AI 应招诊断（lastAIInfo 对应 AI 那手）
            if (!this._maybeOpeningRec() && g.gameMode === 'PvE') this._paintAIInfo(g.lastAIInfo);

            // 让新威胁态立即上屏（首 handler 已渲染一次，这里补一次以反映 threat）
            this._render();
        }

        /** 把引擎诊断（lastAIInfo）写进 #ai-best-move / #ai-source / #ai-diagnostics */
        _paintAIInfo(info) {
            const C = GMK.C;
            const bestEl = this._$('ai-best-move');
            // ⚠ 引擎契约：info.move 是「填充索引」（Int8 一维下标），
            // 必须用 C.xOf / C.yOf 翻译成棋盘坐标（共享知识 §6）
            if (!info || !C || info.move == null || info.move < 0 || !C.inBoard(info.move)) {
                if (bestEl) bestEl.textContent = '—';
                return;
            }
            const x = C.xOf(info.move), y = C.yOf(info.move);
            if (bestEl) bestEl.textContent = cxy(x, y) + ' (' + x + ',' + y + ')';
            const srcEl = this._$('ai-source');
            if (srcEl) srcEl.textContent = SOURCE_LABELS[info.source] || String(info.source || '');
            const diagEl = this._$('ai-diagnostics');
            if (diagEl) diagEl.textContent = 'depth ' + (info.depth || 0) + ' / ' +
                (info.nodes || 0) + ' 节点 / ' + (info.timeMs || 0) + 'ms';
            // 提示开关：在棋盘上画出 AI 推荐点（不覆盖落子）
            if (this.showHint) {
                this.renderer.setHint({ x: x, y: y });
                setTimeout(() => this.renderer.clearHint(), 1500);
            }
        }

        /** 优势条：黑/白/均势 渐变填充 */
        _paintAdvantage(adv) {
            const label = this._$('adv-label'), fill = this._$('adv-fill');
            if (!label || !fill) return;
            label.textContent = adv.side === 'black' ? '黑方领先' : adv.side === 'white' ? '白方领先' : '均势';
            label.className = 'adv-tag' + (adv.side === 'black' ? ' is-black' : adv.side === 'white' ? ' is-white' : '');
            // score 为黑视角：正=黑领先。填充分宽度=黑方份额，±48% 内线性
            const ratio = Math.max(-48, Math.min(48, (adv.score / 1000000) * 48));
            fill.style.width = Math.round(50 + ratio) + '%';
        }

        /* ---------------- P2-5：HELL 高级棋力选项 ---------------- */

        /** 绑定高级参数面板（DOM 可选，全部缺席时静默跳过） */
        _bindStrengthAdvanced() {
            const T = GMK.TunableAI;
            if (!T) return;
            const onChange = () => this._applyStrengthInputs();
            for (const id of ['adv-time', 'adv-depth', 'adv-cand']) {
                const el = this._$(id);
                if (el) el.addEventListener('change', onChange);
            }
            const rst = this._$('btn-strength-reset');
            if (rst) rst.addEventListener('click', () => {
                this._setStrengthInputs(T.defaults());
                this._applyStrengthInputs();
                this._hint('高级强度已恢复引擎默认');
            });
            // 恢复上次的自定义参数；无存档时输入框显示引擎默认
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem('gmk_strength_hell') || 'null'); } catch (e) { saved = null; }
            if (saved) {
                this._setStrengthInputs(T.sanitize(saved));
                this._applyStrengthInputs(true);
            } else {
                this._setStrengthInputs(T.defaults());
            }
        }

        _setStrengthInputs(v) {
            const map = { 'adv-time': v.timeMs, 'adv-depth': v.depth, 'adv-cand': v.candidates };
            for (const id in map) {
                const el = this._$(id);
                if (el) el.value = String(map[id]);
            }
        }

        /** 读输入框 → sanitize → 注入包装 AI + 持久化（等于引擎默认则自动清空） */
        _applyStrengthInputs(silent) {
            const T = GMK.TunableAI;
            if (!T || !this.aiWrapper) return;
            const v = T.sanitize({
                timeMs: parseFloat(this._$('adv-time') && this._$('adv-time').value),
                depth: parseFloat(this._$('adv-depth') && this._$('adv-depth').value),
                candidates: parseFloat(this._$('adv-cand') && this._$('adv-cand').value)
            });
            this.strengthOverride = this.aiWrapper.setOverride(v);
            if (this.strengthOverride) localStorage.setItem('gmk_strength_hell', JSON.stringify(this.strengthOverride));
            else localStorage.removeItem('gmk_strength_hell');
            if (!silent) this._hint('高级强度：' + v.timeMs + 'ms / ' + v.depth + ' 层 / ' + v.candidates + ' 候选');
        }

        /* ---------------- P2-6：开局定式推荐 ---------------- */

        /**
         * 开局窗口（盘面 < 4 子）内给当前行棋方推荐定式点：填分析面板
         * 「AI 推荐 / source=开局」，并复用 P0 的 hint 渲染通道（1.5s 高亮）。
         * @returns {boolean} 是否处于开局窗口并已绘制推荐
         */
        _maybeOpeningRec() {
            const g = this.game;
            if (!GMK.Analysis || typeof GMK.Analysis.openingRecommendation !== 'function') return false;
            if (g.gameStatus === 'finished') return false;
            if (g.gameMode === 'EvE' || g.gameMode === 'VCF_PRACTICE') return false;
            if (g.moves.length >= 4) return false;
            const rec = GMK.Analysis.openingRecommendation(g.getBoardState(), g.currentPlayer);
            if (!rec) return false;
            const bestEl = this._$('ai-best-move'), srcEl = this._$('ai-source'), diagEl = this._$('ai-diagnostics');
            if (bestEl) bestEl.textContent = cxy(rec.x, rec.y) + ' (' + rec.x + ',' + rec.y + ')';
            if (srcEl) srcEl.textContent = '开局';
            if (diagEl) diagEl.textContent = '开局定式推荐 · 前 4 手（已落 ' + rec.stones + ' 子）';
            if (this.showHint) {
                this.renderer.setHint({ x: rec.x, y: rec.y });
                setTimeout(() => this.renderer.clearHint(), 1500);
            }
            return true;
        }

        /** 手动深度评估：遮罩上屏 → 同步搜索（默认 500ms 上限）→ 画前 3 条变例 */
        _runDeepEval() {
            const g = this.game;
            if (!GMK.Analysis || g.gameStatus === 'finished' || this._evaluating) return;
            this._evaluating = true;
            const mask = this._$('ai-thinking');
            if (mask) { mask.textContent = 'AI 计算中…'; this._show('ai-thinking', true); }
            // 同步调用会卡主线程：先让遮罩上屏一帧再开搜（HELL 下 500ms 仍可能久，已限默认 500ms）
            setTimeout(() => {
                try {
                    const res = GMK.Analysis.evaluate(g.getBoardState(), g.currentPlayer,
                        { timeMs: 500, depth: 8, candidates: 10 });
                    this._paintDeepEval(res);
                } catch (e) {
                    this._hint('深度评估失败：' + (e && e.message || e));
                } finally {
                    if (mask) mask.textContent = 'AI 思考中…';
                    this._show('ai-thinking', false);
                    this._evaluating = false;
                }
            }, 30);
        }

        /** 把 evaluate 结果画进面板：最优着法 + 诊断 + 主要变例（前 3） */
        _paintDeepEval(res) {
            const bestEl = this._$('ai-best-move'), srcEl = this._$('ai-source');
            const diagEl = this._$('ai-diagnostics'), pvEl = this._$('ai-pv-list');
            const b = res.best;
            if (bestEl) {
                bestEl.textContent = (b && b.x >= 0)
                    ? cxy(b.x, b.y) + ' (' + b.x + ',' + b.y + ')' : '—';
            }
            if (srcEl) srcEl.textContent = SOURCE_LABELS[res.source] || String(res.source || '搜索');
            if (diagEl && b) diagEl.textContent = 'depth ' + b.depth + ' / ' + b.nodes +
                ' 节点 / ' + b.timeMs + 'ms';
            if (pvEl) {
                pvEl.textContent = '';
                for (let i = 0; i < Math.min(3, res.ranking.length); i++) {
                    const r = res.ranking[i];
                    const li = document.createElement('li');
                    li.textContent = (i + 1) + '. ' + cxy(r.x, r.y) + ' · ' +
                        (r.score >= 50000 ? '强' : r.score > 0 ? '优' : '平');
                    pvEl.appendChild(li);
                }
            }
            if (this.showThreat && b && b.x >= 0) this._currentThreat = null; // 评估后重扫
            this._refreshAIOverlays();
        }

        /** 威胁开关 / 提示开关变化 → 立即重渲染棋盘 */
        _refreshAIOverlays() {
            this._render();
        }

        /** VCF 练习：选题 → 载入棋盘 → 切 VCF_PRACTICE 模式 → 计时 */
        _startVcf() {
            const V = GMK.VCFPractice;
            if (!V) return;
            const sel = this._$('vcf-puzzle-select');
            const idx = sel ? (parseInt(sel.value, 10) || 0) : 0;
            const p = V.start(idx);
            if (!p) return;
            this.vcfPuzzle = p;
            this.vcfStartTs = Date.now();
            this.game.setGameMode('VCF_PRACTICE');
            if (!V.loadBoard(this.game)) { this._hint('题目载入失败'); return; }
            this._updatePanelVisibility();
            this._render();
            this._hint('VCF 练习：' + p.title + '（' + (p.difficulty || '—') + '）— ' + p.description);
        }

        /** VCF 面板状态：显示历史最佳 */
        _renderVcfStatus() {
            const el = this._$('vcf-status');
            if (!el) return;
            const best = GMK.VCFPractice.getBest();
            const p = this.vcfPuzzle;
            if (p && best[p.id]) el.textContent = '历史最佳 ' + best[p.id] + 'ms';
            else el.textContent = '—';
        }

        /** 终局 / 新对局：清除威胁高亮、变例与诊断 */
        _clearAIOverlays() {
            this._currentThreat = null;
            this.renderer.clearHint();
            const pv = this._$('ai-pv-list');
            if (pv) pv.textContent = '';
            const bestEl = this._$('ai-best-move');
            if (bestEl) bestEl.textContent = '—';
            const srcEl = this._$('ai-source');
            if (srcEl) srcEl.textContent = '';
            const diagEl = this._$('ai-diagnostics');
            if (diagEl) diagEl.textContent = '—';
            this._paintAdvantage({ side: 'equal', score: 0, depth: 0 });
            this._render();
        }

        /* ---------------- 公共交互 ---------------- */
        setMode(mode, silent) {
            this.game.setGameMode(mode);
            localStorage.setItem('gmk_mode', mode);
            for (const m of ['PvP', 'PvE', 'EvE']) {
                const el = this._$('mode-' + m);
                if (el) el.classList.toggle('active', m === mode);
            }
            this._updatePanelVisibility();
            this.newGame();
            if (!silent) {
                const names = { PvP: '双人对战', PvE: '人机对战', EvE: 'AI 对战', VCF_PRACTICE: 'VCF 练习' };
                this._hint('已切换为：' + (names[mode] || mode));
            }
            // 注意：EvE 的自动对局由 newGame() 内部统一启动（见 newGame 末尾）。
            // 此处不可再调 _startEvE()：EvE 改为异步单步后，重复调用会派生两条
            // 并行的自动落子链（每步落两手），既浪费算力也打乱测试时序。
        }

        /**
         * AI 增强面板可见性：
         *  - #ai-analysis-panel：PvP/PvE/VCF_PRACTICE 显示，EvE 隐藏
         *  - #vcf-panel：始终显示（独立练习入口）
         */
        _updatePanelVisibility() {
            const m = this.game.gameMode;
            this._show('ai-analysis-panel', m !== 'EvE');
            this._show('vcf-panel', true);
        }

        setDifficulty(d, silent) {
            this.game.setAIDifficulty(d);
            localStorage.setItem('gmk_diff', d);
            for (const x of GMK.Game.DIFFS) {
                const el = this._$('diff-' + x);
                if (el) el.classList.toggle('active', x === d);
            }
            this._show('strength-advanced', d === 'HELL'); // P2-5：仅地狱档显示高级选项
            if (!silent) this._hint('AI 难度：' + (DIFF_LABELS[d] || d));
        }

        setTheme(t, silent) {
            this.theme = t;
            this.renderer.setTheme(t);
            document.body.setAttribute('data-theme', t);
            localStorage.setItem('gmk_theme', t);
            for (const x of ['wood', 'dark', 'light']) {
                const el = this._$('theme-' + x);
                if (el) el.classList.toggle('active', x === t);
            }
        }

        newGame() {
            this.eveAutoPlay = false;
            this._cancelAIThink();
            this.game.reset();
            this.renderer.setWinLine(null);
            this.renderer.clearHint();
            this._currentThreat = null;
            this._clearAIOverlays();
            this._render();
            this._maybeOpeningRec(); // P2-6：新局即给开局推荐（EvE/VCF 内部自动跳过）
            const names = { PvP: '双人对战开始，黑棋先手', PvE: '人机对战开始，你执黑', EvE: 'AI 对战开始' };
            this._hint(names[this.game.gameMode] || '新对局开始');
            if (this.game.gameMode === 'EvE') this._startEvE();
        }

        undo() {
            this._cancelAIThink();
            if (this.game.undo(1)) {
                this._render();
                this._maybeOpeningRec(); // P2-6：悔回开局窗口时恢复推荐
                this._hint('已悔一步');
            }
            else this._hint('没有可悔的棋');
        }

        _onPlayerClick(x, y) {
            if (this.game.gameStatus === 'finished') return;
            if (this.game.gameMode === 'EvE') { this._hint('机机对战模式，玩家无法操作棋盘'); return; }
            if (this.aiThinking) return;

            const result = this.game.placePiece(x, y);
            if (!result.success) {
                if (result.code === 'FORBIDDEN_MOVE') { /* forbidden 事件已提示 */ }
                else this._hint('无法在此落子（' + result.code + '）');
                return;
            }

            this._render();

            if (result.gameOver) { this._showResult(result); return; }

            // 轮到 AI？排期到「玩家这一手上屏之后」再开算，绝不在此同步搜索
            if (this._shouldAIMove()) {
                this._scheduleAIThink(0);
            }
        }

        _shouldAIMove() {
            const g = this.game;
            if (g.gameMode === 'PvE') return g.currentPlayer === 2; // 玩家执黑，AI 执白
            if (g.gameMode === 'EvE') return true;
            return false;
        }

        /**
         * 排期一次 AI 思考：先让浏览器把「玩家刚落的那一手」画到屏幕上，再开算。
         *
         * 旧实现是 placePiece → _render → getAIMove 全在同一个任务里同步跑完，
         * 浏览器从头到尾没有机会上屏 —— 玩家点完看到的是「没有任何反应」，
         * 然后 AI 的棋子连同自己的棋子一起突然出现（HELL 档尤其明显，3.5s 全程静止）。
         *
         * 这里用 requestAnimationFrame + setTimeout 两段让出：
         *   rAF  → 本帧绘制前回调，随后浏览器绘制（玩家棋子此时上屏）
         *   timer → 绘制之后的下一轮宏任务，才进入同步搜索
         * aiThinking 在「排期瞬间」就置 true：AI 还没开始算，但棋盘已经禁止再落子，
         * 否则连点两下会插进两手黑棋。
         */
        _scheduleAIThink(delay) {
            if (this._aiPending || this.aiThinking) return;
            this._aiPending = true;
            this.aiThinking = true;
            this._show('ai-thinking', true);

            const wait = typeof delay === 'number' ? delay : 0;
            this._aiRaf = requestAnimationFrame(() => {
                this._aiRaf = 0;
                this._aiTimer = setTimeout(() => {
                    this._aiTimer = 0;
                    this._aiPending = false;
                    const abort = this.game.gameStatus === 'finished' ||
                        !this._shouldAIMove() ||
                        (this.game.gameMode === 'EvE' && !this.eveAutoPlay);
                    if (abort) {
                        this.aiThinking = false;
                        this._show('ai-thinking', false);
                        return;
                    }
                    this._thinkAndMove();
                }, wait);
            });
        }

        /** 撤销排期中的 AI 思考（新局 / 悔棋 / 重置 / 终局都要调，否则会往新盘上补子） */
        _cancelAIThink() {
            this._aiPending = false;
            if (this._aiRaf) { cancelAnimationFrame(this._aiRaf); this._aiRaf = 0; }
            if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = 0; }
            if (this.aiThinking) {
                this.aiThinking = false;
                this._show('ai-thinking', false);
            }
        }

        _thinkAndMove() {
            this.aiThinking = true;
            this._show('ai-thinking', true);
            const ai = this.game.getAIMove();
            this._show('ai-thinking', false);
            this.aiThinking = false;

            if (!ai) return;
            const r = this.game.placePiece(ai.x, ai.y);
            this._render();
            this.renderer.setHint({ x: ai.x, y: ai.y });
            setTimeout(() => this.renderer.clearHint(), 800);
            if (r && r.gameOver) {
                this._showResult(r);
            } else if (this.game.gameMode === 'EvE' && this.eveAutoPlay) {
                // EvE 异步单步：走同一套排期逻辑，绝不在此同步递归。
                // 旧实现是同步递归，EvE 下 _shouldAIMove() 恒 true，会把整局
                // （最多 225 手 × 难度思考时长）一口气打完并堵死 UI 线程，
                // 导致 setMode('EvE') 长时间不返回、后续面板/时序断言全部超时。
                this._scheduleAIThink(60);
            }
            // PvE 不递归：白应招后 currentPlayer 变 1，_shouldAIMove() 为 false。
        }

        _startEvE() {
            this.eveAutoPlay = true;
            if (this.game.gameStatus === 'playing' || this.game.gameStatus === 'ready') {
                this._hint('机机对战中，稍候…');
                // 留 80ms 让「机机对战中」提示先上屏，再开始第一步同步搜索
                this._scheduleAIThink(80);
            }
        }

        _render() {
            const g = this.game;
            const last = g.getLastMove();
            // 威胁点：仅威胁开关开启且处于对局中时绘制
            const threat = (this.showThreat && this._currentThreat &&
                g.gameStatus !== 'finished') ? this._currentThreat : null;
            this.renderer.render(g.getBoardState(), {
                lastMove: last ? { x: last.x, y: last.y, player: last.player } : null,
                threat: threat
            });
            // 状态面板
            const info = g.getGameInfo();
            const cp = this._$('current-player');
            if (cp) cp.textContent = g.gameStatus === 'finished'
                ? (g.winner === 0 ? '平局' : (g.winner === 1 ? '黑方胜' : '白方胜'))
                : (g.currentPlayer === 1 ? '黑方' : '白方') + '行棋';
            const mv = this._$('move-count');
            if (mv) mv.textContent = '第 ' + info.moveCount + ' 手';
        }

        _showResult(result) {
            const g = this.game;
            this._cancelAIThink();
            const title = this._$('result-title'), detail = this._$('result-detail'), modal = this._$('game-result-modal');
            if (!title || !modal) return;
            if (result.winner === 0) { title.textContent = '平局'; detail.textContent = '棋盘已满，不分胜负'; }
            else {
                const w = result.winner === 1 ? '黑方' : '白方';
                title.textContent = w + '获胜';
                const ai = g.lastAIInfo;
                detail.textContent = '共 ' + g.moves.length + ' 手' + (ai ? ' · 引擎 ' + (ai.depth || 0) + ' 层 / ' + (ai.nodes || 0) + ' 节点' : '');
            }
            modal.classList.add('active');
            this.game.setWinLine && 0; // winLine 由渲染器 drawWinLine 处理
            const wl = result.winLine;
            if (wl) this.renderer.setWinLine(wl);
            this._render();
        }

        _hint(msg) {
            const el = this._$('hint-message');
            if (el) { el.textContent = msg; el.classList.add('show'); }
        }

        /* ---------------- 快捷键 ---------------- */
        bindShortcuts() {
            document.addEventListener('keydown', e => {
                if (e.key === 'u' || e.key === 'U') this.undo();
                if (e.key === 'n' || e.key === 'N') this.newGame();
                if (e.key === 'Escape') this._show('game-result-modal', false);
            });
        }

        closeResultModal() {
            const m = this._$('game-result-modal');
            if (m) m.classList.remove('active');
            const btn = this._$('close-result-btn');
            if (btn) btn.addEventListener('click', () => this.closeResultModal());
        }

        start() {
            this.bindShortcuts();
            this.closeResultModal();
            this._render();
        }
    }

    GMK.App = App;
    if (typeof module !== 'undefined' && module.exports) module.exports = App;
})();
